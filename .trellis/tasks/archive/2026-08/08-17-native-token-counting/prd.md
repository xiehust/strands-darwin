# Use native Bedrock token counting and fix Mantle window

## Goal

Make `/context` use the provider-native Bedrock CountTokens API where available and report the known
1,050,000-token window for prefixed OpenAI/Mantle GPT 5.6 model IDs, while retaining heuristic token
estimation for OpenAI Responses.

## Requirements

- Construct every Darwin BedrockModel with `useNativeTokenCount: true`.
- Preserve SDK fallback behavior when CountTokens is unsupported or IAM denies it.
- Keep OpenAI Responses on the SDK character heuristic; do not add a provider call.
- Set OpenAI/Mantle `contextWindowLimit` from a Darwin-owned lookup that understands
  `openai.gpt-5.6-sol` and related prefixed IDs.
- Ensure `/model` reconstruction keeps the metadata correct for each target model.
- Correct `/context` wording so it does not always claim the estimate is heuristic when native
  counting may be active.

## Acceptance Criteria

- [x] Bedrock model config exposes `useNativeTokenCount: true`.
- [x] `openai.gpt-5.6-sol` model config exposes `contextWindowLimit: 1_050_000`.
- [x] Unknown OpenAI model IDs remain `window unknown`; known non-prefixed IDs remain compatible.
- [x] OpenAI `countTokens()` remains heuristic and makes no network request in focused tests.
- [x] Context formatting distinguishes a token count from its native/heuristic implementation detail.
- [x] Focused config/context tests, typecheck, full offline suite, build, completion, Trellis validation,
      and diff checks pass.
