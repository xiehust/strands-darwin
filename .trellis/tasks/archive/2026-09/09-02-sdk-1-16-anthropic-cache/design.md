# Design — SDK 1.16.0 upgrade + anthropic cacheConfig

## Patch regeneration (the risky part)

Procedure (spec § FileEditor recovery: "regenerate the pnpm patch from the pristine package"):
1. `pnpm-workspace.yaml`: drop the 1.12.0 `patchedDependencies` entry, add
   `ignoredOptionalDependencies: ['@tobilu/qmd']`; `pnpm add @strands-agents/sdk@1.16.0`.
2. `pnpm patch @strands-agents/sdk@1.16.0` → edit dir; `patch -p1 < patches/@strands-agents__sdk@1.12.0.patch`
   (11/14 hunks apply, offsets only). Hand-port the three rejects:
   - `bash/index.js` + `.d.ts`: 1.16 re-shaped the index (shell tools moved to `../shell`, deprecated
     alias added). Add `createBash` to the `export { bash } from './bash.js'` line, nothing else.
   - `file-editor.js` hunk 3: 1.16 replaced the regex/tab-expansion occurrence count with
     `findOccurrences(originalContent, oldStr)` returning `{offset,line}[]`. Port the miss branch only:
     on zero occurrences build `formatMissContext(originalContent, oldStr)` + `formatOldStrForError` and
     throw the same two-paragraph message. Hunks 1–2 (helpers) apply as-is. Tab expansion is gone
     upstream, so the advisory is computed on the raw content — `verify-file-editor.ts` decides whether
     any assertion depended on expansion.
3. `pnpm patch-commit <dir>` → `patches/@strands-agents__sdk@1.16.0.patch`; delete the old file.
4. `node --check` the installed `file-editor.js`, `bash.js`, `plugin.js`, `index.js`.

## API adaptation

- `ToolContext.cancelSignal: AbortSignal` required → `src/skills/plugin.ts:125` passes
  `new AbortController().signal` (the private skills tool is never cancelled through this path);
  the two spikes building a fake `ToolContext` add the same field.
- `DEFAULT_SUMMARIZATION_PROMPT` / `createBash` / `BashSessionError` fields come back with the patch.

## Anthropic caching

`src/agent/prompt-cache.ts`:
- `planPromptCache` anthropic branch → `{ enabled: true, automatic: false, parts: ['tools','system prompt','conversation'], ttl }`.
- New `anthropicCacheConfig(plan): CacheConfig | undefined` (type from `@strands-agents/sdk` root
  `CacheConfig`) — `undefined` when the plan caches nothing, else `{ ...(ttl && { ttl }) }`; sections
  default to on. Mirrors `bedrockCacheConfig` (one TTL everywhere).
`src/config.ts` `createAnthropicModel`: spread `cacheConfig` when defined. `/effort` `updateConfig`
path untouched (it only rewrites `params`).
The hand-placed system-prompt `CachePointBlock` stays: 1.16 `_formatSystem` honours it with
`nextBlock.ttl || systemCache.ttl`, so the plan's TTL and the point agree.

## Rollback

Revert the commit; `pnpm install --frozen-lockfile` restores 1.12.0 + its patch from the lockfile.
