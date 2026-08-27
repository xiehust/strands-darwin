# Design

## Data flow

`Ctrl+O` in idle/busy text-composer ownership → OS clipboard adapter reads a bounded temporary image → shared image decoder validates/normalizes it → App stores an opaque byte-backed `ImageBlock` beside the draft → a bounded `image attached · … (Ctrl+O remove)` chip renders inside the counted prompt claim → submit snapshots `{ text, image }` → busy path queues that pair, idle ordinary-prompt path calls `AgentRuntime.send(modelText, literalText, image)` → runtime forms `[TextBlock, ImageBlock]` and calls its existing `agent.stream()` once.

Clipboard bytes do not cross into trajectory, memory, shell reports, command expansion, rewind prompt text, prompt history, replay, or export. These continue receiving strings. The image exists only in the live App/queue and SDK conversation.

## Boundary choices

- **Gesture:** `Ctrl+O` toggles attachment: without an image it reads clipboard; with an image it removes it. It is currently unowned, works as a raw C0 key in pty tests, and one chip can state both attachment and removal. Clipboard reads occur only while the prompt owns input; permission/search/rewind modes keep precedence.
- **Clipboard adapter:** a small injectable module uses bounded `spawn` calls to established platform helpers (`wl-paste` under Wayland, `xclip` under X11, `pngpaste` on macOS). Missing helpers/session support is an explicit bounded error. No shell and no dependency are introduced. Tests put a fixture helper on `PATH`.
- **Decoder reuse:** refactor the existing loader to expose a byte/source-name entry point. Path loading remains responsible for bounded stable file reads; both entry points call the same metadata/format/normalization function.
- **Queue:** replace queue strings with `{ text, image? }`. Pure projections accept the pair and mention `[image]` without bytes. Take-back merges text as today and restores all owned images; current UX permits one image, so ordinary operation restores at most one, while the representation avoids future loss.
- **Runtime:** widen only `send` with an optional `ImageBlock`. Every observer still receives text. Rewind eligibility/catalogue use literal/model text exactly as before; image-bearing turns skip rewind capture because a text-only checkpoint label cannot truthfully recreate the submitted multimodal boundary.
- **Provider errors:** no speculative capability call. The ordinary SDK/provider failure is shown by the existing turn error surface. Since acceptance into send has already happened, the chip clears; the SDK/session manager remains authoritative about conversation rollback/persistence.

## Change boundary

Expected source changes: shared image decoder (`src/tools/image-viewer.ts`), clipboard adapter (new `src/tui/clipboard-image.ts`), queue projections, App state/key/submit/render flow, InputBox chip, frame-budget prompt count, runtime content-block send, help text. Focused spike tests cover decoder/runtime and pty behavior. Specs/docs/AGENTS add the invariant.

Not changing SDK patches, provider implementations, trajectory schema, memory schema, shell records, headless protocols, path imageViewer contract, or Agent construction ownership.
