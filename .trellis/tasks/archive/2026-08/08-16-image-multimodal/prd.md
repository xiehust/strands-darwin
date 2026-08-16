# Add image multimodal support

## Goal

Enable darwin to inspect local image files as visual input to a multimodal model, so coding tasks can refer to screenshots, diagrams, and other image artifacts rather than relying on text-only descriptions.

## Background and Confirmed Facts

- The current TUI and headless paths ultimately call `AgentRuntime.send(input: string)`, so user turns are text-only.
- `@strands-agents/sdk` 1.12.0 already accepts `ContentBlock[]` for `Agent.stream()` and exports `ImageBlock`; no new image-model SDK is inherently required.
- SDK `ImageBlock` supports byte, URL, and S3 sources. This request is specifically about image files; URL, S3, video, and document input are not assumed to be in scope.
- The TUI has no attachment state or image-specific command today.
- Darwin already exposes read-oriented tools and shares its configured tool set with the agent loop; a read-only image-view tool would fit the coding-agent interaction model without a separate terminal attachment UI.

## Requirements

- Add a built-in read-only `imageViewer` tool. A user continues to type ordinary prompts such as “analyze `screenshots/error.png`”; the model decides when to call the tool.
- The tool must serve both TUI and headless runs through the shared Agent tool catalogue, without attachment state or new prompt syntax.
- Accept PNG, JPEG, GIF, and WebP local files and provide their bytes and format to the active model as a real SDK image content block, not OCR-only text or base64 embedded in a prompt.
- Resolve relative paths from darwin's explicit project root; accept absolute paths consistently with existing read tools.
- Preserve a valid static image unchanged when it already fits Bedrock's 3.75 MiB and 8000×8000 limits.
- Automatically normalize images that exceed either Bedrock limit: apply EXIF orientation, resize within 8000×8000, encode as WebP, then reduce quality/dimensions as needed until the payload fits.
- Treat animated GIF input as a static image by extracting its first frame before model submission.
- Bound source ingestion at 50 MiB and decoded input at 100 megapixels to prevent excessive memory/CPU use; serialize image processing across parent/child calls and reject inputs that cannot be made compliant within those bounds.
- Reject missing, unreadable, non-regular, empty, unsupported, or extension/content-mismatched files with a clear actionable tool error while keeping the session usable.
- Classify the tool as a read so it works without approval in default/auto/plan/headless modes while remaining visible to configured tool hooks.
- Make the tool available to the parent and to child agents whose tool policy permits it.
- Preserve existing text-only behavior, streaming, permissions, model switching, session persistence, trajectory recording, and headless operation.
- Use Node filesystem APIs, the existing SDK `ImageBlock`, and `sharp` for bounded metadata/decode/resize/encode operations.

## Acceptance Criteria

- [ ] Given “analyze `screenshots/error.png`”, a capable model can call `imageViewer` with that path in both TUI and headless execution.
- [ ] A successful tool call returns an SDK image tool-result block with the canonical format; compliant static input preserves exact bytes, while normalized input returns the generated WebP bytes.
- [ ] Relative paths resolve against `projectRoot`; absolute paths resolve as given.
- [ ] PNG, `.jpg`/`.jpeg`, GIF, and WebP are accepted case-insensitively, with JPEG normalized to the provider-compatible format.
- [ ] A compliant static image is byte-identical in the SDK image block; an over-byte/over-dimension image is auto-oriented and converted to a WebP no larger than 3.75 MiB and 8000×8000.
- [ ] Animated GIF input produces a static first-frame image result.
- [ ] Missing paths, directories, empty files, unsupported extensions, mismatched content, sources above 50 MiB, inputs above 100 megapixels, and images that cannot be compressed within the model limit become actionable error tool results without terminating darwin.
- [ ] The permission gate classifies `imageViewer` as read, including plan mode and headless default-denial operation.
- [ ] Text-only turns and existing built-in slash-command completion remain unchanged.
- [ ] Offline verification covers path handling, format/signature mapping, size validation, SDK tool-result construction, and permission behavior; typecheck and the fast test suite pass.

## Out of Scope

- Image generation or editing.
- Video, PDF, and general document attachments.
- Remote URL or S3 image ingestion.
- OCR as a separate fallback pipeline.
- Rendering image pixels inside the terminal.

## Key Decisions and Deferred Items

- The primary interaction is a model-invoked read-only tool, not `/image`, `@path`, attachment state, or clipboard integration.
- Local path resolution and validation belong to the tool; TUI and headless code remain text-only drivers.
- Bedrock's per-image caps (3.75 MiB and 8000×8000) are enforced locally. `sharp` is accepted as a new dependency to decode metadata safely and normalize over-limit input.
- Compression starts with WebP quality 85, lowers quality through bounded attempts, then reduces dimensions through bounded attempts; failure to fit is explicit rather than an unbounded loop.
- Animated input is intentionally flattened to its first frame; preserving animation is not useful for the coding screenshot/diagram outcome and costs payload/complexity.
- Whether the active arbitrary model ID supports vision cannot be inferred reliably; an incompatible provider/model failure uses the existing turn-error path.
- Raw clipboard bitmap paste and terminal image rendering remain deferred.
