/**
 * Same-path ordering for the SDK-vended `fileEditor` (SRF-020).
 *
 * The vended `create` / `str_replace` / `insert` handlers are readText → compute →
 * writeText with no lock, and darwin keeps the default `ConcurrentToolExecutor`
 * (never `toolExecutor`, see AGENTS.md "Subagents"). N same-path edits issued in
 * one assistant message therefore each read the original file and the last write
 * wins — while every call reports `status: "success"`.
 *
 * This wrapper keeps the SDK tool as the one implementation: same name, same
 * description, same provider schema, the SDK's own `stream()` and therefore the
 * same result and error bytes. It only decides *when* the delegated call starts:
 * mutating commands on one resolved absolute path await the previous mutation on
 * that path for the same Agent, so each call reads what the previous one wrote.
 * `view`, distinct paths, calls without a usable absolute string path, and every
 * other tool stay concurrent. Chains are keyed per Agent (the vended bash tool's
 * `WeakMap<Agent, …>` precedent), so a child built from the parent's catalogue
 * never shares the parent's chain, and settled entries are removed so the map
 * cannot grow with the session.
 */
import path from 'node:path';

import { Tool } from '@strands-agents/sdk';
import type { ToolContext, ToolSpec, ToolStreamGenerator } from '@strands-agents/sdk';
import { DEFAULT_FILE_EDITOR_DESCRIPTION } from '@strands-agents/sdk/vended-tools/file-editor';

/** The vended schema's commands that reach `sandbox.writeText`. */
export const MUTATING_FILE_EDITOR_COMMANDS: ReadonlySet<string> = new Set(['create', 'str_replace', 'insert']);

/**
 * SRF-032: the payload bound the model reads beside the schema. One whole-document
 * `create` (or one huge `new_str`) can exceed what the provider stream completes —
 * measured twice on the same payload, so the interruption is deterministic and the
 * one automatic continuation cannot help. The guidance lives on the tool, not only in
 * the parent's system prompt, so a child whose prompt omits the rule still sees it.
 */
export const FILE_EDITOR_PAYLOAD_GUIDANCE =
  "Keep every payload bounded: create's file_text and each str_replace/insert new_str must stay within a few thousand words, because one oversized tool-call payload can exceed what the model stream completes and the whole call is lost. Write a long document as a short skeleton (title, headings, placeholders) with create, then fill it section by section with separate str_replace/insert calls — never as one whole-document payload.";

/**
 * The description the runtime gives `makeFileEditor({ description })`: the SDK's own
 * text first, so the tool reads as the vended one, then the payload bound. The
 * wrapper below never touches it — it stays a projection of what it wraps.
 */
export const FILE_EDITOR_DESCRIPTION = `${DEFAULT_FILE_EDITOR_DESCRIPTION} ${FILE_EDITOR_PAYLOAD_GUIDANCE}`;

type PathChains = Map<string, Promise<void>>;

export class SerializedFileEditorTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly toolSpec: ToolSpec;
  /** Per-Agent chains; the Agent object is the key, so `/clear` and children start empty. */
  private readonly chains = new WeakMap<object, PathChains>();

  constructor(private readonly original: Tool) {
    super();
    this.name = original.name;
    this.description = original.description;
    this.toolSpec = original.toolSpec;
  }

  /** Read-only diagnostic: resolved paths with an unsettled mutation chain for one Agent. */
  pendingPaths(agent: object): readonly string[] {
    return [...(this.chains.get(agent)?.keys() ?? [])];
  }

  async *stream(context: ToolContext): ToolStreamGenerator {
    const key = mutationKey(context.toolUse.input);
    const agent: unknown = context.agent;
    if (key === undefined || typeof agent !== 'object' || agent === null) {
      return yield* this.original.stream(context);
    }

    const chains = this.chainsFor(agent);
    const previous = chains.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Entries only ever resolve: a failed or cancelled edit releases the chain in
    // `finally`, so a later edit on the same path is never blocked by it.
    const entry = previous.then(() => settled);
    chains.set(key, entry);
    try {
      await previous;
      return yield* this.original.stream(context);
    } finally {
      release();
      if (chains.get(key) === entry) chains.delete(key);
    }
  }

  private chainsFor(agent: object): PathChains {
    const existing = this.chains.get(agent);
    if (existing !== undefined) return existing;
    const created: PathChains = new Map();
    this.chains.set(agent, created);
    return created;
  }
}

/**
 * The chain key for one tool input, or `undefined` when the call must not be
 * serialized: non-mutating command, non-object input, or no absolute string path.
 * Mirrors what the vended tool writes to: trailing separators stripped, absolute
 * only (`validatePath` rejects relative paths itself), normalized.
 */
export function mutationKey(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const command = record['command'];
  if (typeof command !== 'string' || !MUTATING_FILE_EDITOR_COMMANDS.has(command)) return undefined;
  const raw = record['path'];
  if (typeof raw !== 'string') return undefined;
  const stripped = raw.replace(/[/\\]+$/, '');
  if (!path.isAbsolute(stripped)) return undefined;
  return path.resolve(stripped);
}
