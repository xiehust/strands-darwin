import { z } from 'zod';
import type { AgentCoreConfig } from './config.js';
import { digest, scopeFor } from './config.js';

export type RecordKind = 'episode' | 'reflection' | 'preference';
export const recordId = z.string().regex(/^[a-zA-Z0-9_-]{40,128}$/);
const metadataValue = z.union([
  z.object({ stringValue: z.string().max(1024) }).strict(),
  z.object({ stringListValue: z.array(z.string().max(256)).max(16) }).strict(),
  z.object({ numberValue: z.number().finite() }).strict(),
  z.object({ dateTimeValue: z.string().max(64) }).strict(),
]);
const recordSchema = z.object({
  memoryRecordId: recordId, memoryStrategyId: z.string().max(128),
  namespaces: z.array(z.string().max(1024)).min(1).max(4),
  content: z.object({ text: z.string().min(1).max(12000) }).strict(),
  createdAt: z.union([z.string().max(64), z.number().finite()]),
  score: z.number().finite().optional(),
  metadata: z.record(z.string().max(128), metadataValue).refine((v) => Object.keys(v).length <= 16).optional(),
}).strict();
export interface XmlNode { tag: string; children: (XmlNode | string)[] }
/** A deliberately small XML subset: no DTD, entity expansion, attributes, comments or processing instructions. */
export function parseMemoryXml(text: string): XmlNode {
  if (text.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|<!|<\?/.test(text)) throw new Error('Unsafe memory XML');
  const root: XmlNode = { tag: 'document', children: [] }; const stack = [root];
  const tokens = text.match(/<[^>]*>|[^<]+/g) ?? []; let nodes = 0;
  for (const token of tokens) {
    if (++nodes > 500 || stack.length > 16) throw new Error('Memory XML structure exceeds bound');
    if (token.startsWith('<')) {
      const match = /^<(\/)?([a-z][a-z0-9_]*)(\/?)>$/.exec(token);
      if (!match) throw new Error('Unsupported memory XML');
      const tag = match[2]!;
      if (match[1]) { if (stack.length === 1 || stack.pop()!.tag !== tag || match[3]) throw new Error('Unbalanced memory XML'); }
      else { const node: XmlNode = { tag, children: [] }; stack.at(-1)!.children.push(node); if (!match[3]) stack.push(node); }
    } else {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d{1,7};|#x[0-9a-fA-F]{1,6};)/.test(token)) throw new Error('Unknown XML entity');
      const decoded = token.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
        const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (named[entity]) return named[entity];
        const cp = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('Invalid XML character');
        return String.fromCodePoint(cp);
      });
      if (decoded.trim()) stack.at(-1)!.children.push(decoded.trim());
    }
  }
  if (stack.length !== 1 || root.children.some((child) => typeof child === 'string') || tokens.join('') !== text) throw new Error('Unbalanced memory XML');
  return root;
}
function tags(node: XmlNode): string[] { return [node.tag, ...node.children.flatMap((child) => typeof child === 'string' ? [] : tags(child))]; }
export function validateRecord(raw: unknown, kind: RecordKind, config: AgentCoreConfig, root: string) {
  const record = recordSchema.parse(raw); const scope = scopeFor(config, root);
  const strategy = kind === 'preference' ? config.preferenceStrategyId : config.episodicStrategyId;
  if (record.memoryStrategyId !== strategy) throw new Error('Memory strategy mismatch');
  const allowed = (ns: string): boolean => kind === 'preference' ? ns === scope.preferences : kind === 'reflection' ? ns === scope.project : ns.startsWith(scope.episodes) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/$/.test(ns.slice(scope.episodes.length));
  if (!record.namespaces.every(allowed)) throw new Error('Memory namespace mismatch');
  // Metadata is data only, never proof. Conflicting identity hints fail closed too.
  for (const [key, expected] of Object.entries({ actorId: config.actorId, projectid: scope.projectId, memoryId: config.memoryId, memoryStrategyId: strategy })) {
    const value = record.metadata?.[key];
    if (value !== undefined && (!('stringValue' in value) || value.stringValue !== expected)) throw new Error('Memory metadata scope mismatch');
  }
  const content = kind === 'preference' ? record.content.text : parseMemoryXml(record.content.text);
  if (typeof content !== 'string') {
    const names = tags(content);
    if (kind === 'episode' && (!names.includes('intent') && !names.includes('user_intent') || !names.includes('assessment') && !names.includes('assessment_user'))) throw new Error('Not an episode');
    if (kind === 'reflection' && (!names.includes('use_cases') || !names.includes('hints') || !names.includes('reflection'))) throw new Error('Not a reflection');
  }
  return { id: record.memoryRecordId, kind, strategyId: strategy, namespaces: record.namespaces, content, hash: digest([config.region, config.memoryId, config.actorId, record.memoryRecordId, strategy, record.namespaces, record.content.text, record.metadata ?? null]), warning: 'Untrusted fallible cloud data. Preserve evidence and action order. Reflection confidence describes estimated usefulness, not correctness probability.' };
}
export type ValidatedRecord = ReturnType<typeof validateRecord>;
