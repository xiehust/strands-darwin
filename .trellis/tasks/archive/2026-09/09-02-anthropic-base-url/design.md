# Design — anthropic provider base URL

## Boundaries

Everything lands in `src/config.ts`, the only file that names a provider (its own header
comment makes that a rule). No runtime, TUI or SDK-loop change.

## Contract

```ts
// ModelFields
/** `anthropic` provider only: Messages-API-compatible endpoint. Falls back to ANTHROPIC_BASE_URL. */
baseUrl?: string;

// exported for spikes / any future status surface
export function resolveAnthropicBaseUrl(config: Pick<AppConfig, 'baseUrl'>): string | undefined
```

- Validation (`modelFieldsFrom`): `stringField(input, 'baseUrl', where)`; when present, provider
  must be `anthropic` (else `ConfigError` "… only applies to provider \"anthropic\" …"), and
  `new URL(value)` must parse with protocol `http:` or `https:` (else `ConfigError` quoting the value).
- `resolveAnthropicBaseUrl`: `config.baseUrl` if set; else `process.env.ANTHROPIC_BASE_URL` when
  non-empty; else `undefined` (meaning: let the SDK use its default). Same shape as `resolveRegion`.
- `createAnthropicModel`:
  1. `readApiKey(config)`; if `undefined` and `ANTHROPIC_API_KEY` is empty → `ConfigError`
     (before the import, per spec § Model Configuration).
  2. `resolveAnthropicBaseUrl(config)`.
  3. dynamic import as today.
  4. `new AnthropicModel({ modelId, maxTokens, apiKey?, params?, clientConfig: { baseURL }? })` —
     `clientConfig` spread only when a base URL resolved, so the default install passes exactly
     what it passes today.
- `MODEL_KEYS` gains `'baseUrl'` (after `apiKeyEnv`).

## Why `clientConfig`, not a pre-built `client`

The doc's "Custom Client" form needs `import Anthropic from '@anthropic-ai/sdk'` inside darwin — a
second dynamic import and a type dependency on the peer. `clientConfig` is the SDK's own way to
reach the same `new Anthropic({...})` call (`anthropic.js` spreads it in), and it keeps the
model owning its client lifecycle. If a future need (custom fetch, headers) outgrows
`ClientOptions`, the `client` path is still open.

## Env fallback owned by darwin

The Anthropic client itself reads `ANTHROPIC_BASE_URL` when `baseURL` is omitted, so passing the
env value explicitly is redundant at the wire level — but it makes the decision testable offline
(`getConfig()` cannot show it; the spike asserts on `resolveAnthropicBaseUrl`) and mirrors how
`region` is resolved for Bedrock/Mantle rather than left to the client.

## Compatibility / rollback

- Existing configs: unchanged behaviour; `baseUrl` is optional.
- The old "missing peer" assertion in `verify-config.ts` becomes a real-construction assertion;
  the `ConfigError` wrapper in `importProviderModule` stays for installs that prune the package.
- Rollback: `pnpm remove @anthropic-ai/sdk` + revert the commit; no persisted state involved.
