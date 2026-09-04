# Implementation plan

1. `pnpm add @anthropic-ai/sdk` (peer range `^0.109.1` from the SDK's package.json).
2. `src/config.ts`
   - `ModelFields.baseUrl?: string` with doc comment; `MODEL_KEYS` += `'baseUrl'`.
   - `modelFieldsFrom`: parse/validate `baseUrl` (anthropic-only, http(s) URL).
   - `export function resolveAnthropicBaseUrl(...)`.
   - `createAnthropicModel`: key check → base URL → import → `clientConfig`.
3. `spike/verify-config.ts`: replace the "missing peer" anthropic block with construction + baseUrl
   assertions (fake key via env save/restore, like the openai block does for `OPENAI_API_KEY`).
4. `spike/verify-anthropic-live.ts`: modelled on `verify-mantle-live.ts`; config
   `{ provider: 'anthropic', model: process.argv[2] ?? 'claude-sonnet-4-6', maxTokens: 8192,
   permissionMode: 'yolo' }`; prints the resolved base URL; fix-a-bug turn with tool calls, then
   a one-word follow-up; exit 1 on any failure.
5. Docs: `docs/user-guide/configuration.md` / `.zh-CN.md` row; `getting-started.md` / `.zh-CN.md`
   Direct Anthropic; `README.md` / `README.zh-CN.md` peer sentence; `AGENTS.md` live-suite list;
   `.trellis/spec/backend/strands-sdk-contracts.md` § Model Configuration.

## Validation

```bash
pnpm typecheck
pnpm test
pnpm tsx spike/verify-anthropic-live.ts        # uses ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY from env
pnpm build
```

## Review gates

- `documentedKeys()` in `verify-config.ts` goes green for both doc languages.
- No static `@anthropic-ai/sdk` import anywhere under `src/` (`rg "from '@anthropic-ai" src` empty).
