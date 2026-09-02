# Configurable `contextWindowLimit` override

## Goal

darwin learns a model's context window only from the SDK's static `CONTEXT_WINDOW_LIMITS` table
(`defaults.js`, plus darwin's small `openai.`-prefix table for Mantle). A model id missing from
both reports `window unknown` in `/context` / `/status` and never triggers the context-pressure
`/compact` advice. Let the user state the window in `~/.darwin/config.json`.

## Requirements

1. New optional model field `contextWindowLimit` (integer ≥ 1, tokens; same name as the SDK
   option so no mapping needs explaining). Applies to every provider: passed as `contextWindowLimit`
   to `BedrockModel` / `AnthropicModel` / `OpenAIModel`; an explicit value wins over both the SDK
   table and darwin's Mantle table (SDK contract: "An explicit value always takes precedence").
2. Closed schema stays consistent: `MODEL_KEYS`, both `docs/user-guide/configuration*.md` model
   tables, the `verify-config.ts` flat fixture.
3. No behaviour change when the field is absent.

## Acceptance Criteria

- [ ] `verify-config.ts`: the field loads on all three providers and is visible in
      `model.getConfig().contextWindowLimit`; an unknown model id still reports `undefined` without it;
      the override beats the Mantle table (`openai.gpt-5.6-sol` → configured value); non-integer / < 1 refused.
- [ ] `pnpm typecheck`, `pnpm test`, `tui completion` green; `pnpm build` after commit.
