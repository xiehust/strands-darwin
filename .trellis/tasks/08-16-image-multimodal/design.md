# Design — Read-only local image tool

## Architecture and Boundary

Add one built-in `imageViewer` function tool under `src/tools/` and register it in the runtime's initial tool catalogue beside `bash` and `fileEditor`.

The tool is an SDK extension point, not a change to `AgentRuntime.send()` or the SDK agent loop. The normal flow is:

```
ordinary user text
  → model chooses imageViewer({ path })
  → tool resolves and validates the local file
  → tool returns SDK ImageBlock(bytes, format)
  → SDK places the image in the tool result
  → model visually interprets it on the next model cycle
```

Because the same assembled Agent drives TUI and headless runs, both interfaces gain the capability without input syntax or UI state. The tool enters `childTools` before subagent registration, so the built-in general child and project agents that do not restrict tools can use it; explicit project tool allowlists must name it, preserving their existing capability boundary.

## Tool Contract

- Name: `imageViewer`.
- Input: `{ path: string }` only.
- Relative paths resolve against the explicit `projectRoot` captured when the tool is created.
- Absolute paths are used as given, matching `fileEditor`'s read behavior.
- Supported formats: PNG, JPEG (`.jpg`/`.jpeg`), GIF, and WebP — the intersection exposed by the SDK and Bedrock Converse.
- Bedrock output limits: 3.75 MiB (`3_932_160` bytes) and 8000×8000.
- Source safety limits: 50 MiB compressed bytes and 100 megapixels decoded input. These are Darwin resource bounds, not provider claims.
- Parent and child agents share one tool instance, which serializes Sharp work so concurrent model tool calls cannot multiply the per-image native-memory bound.
- A compliant, static image keeps its exact source bytes and canonical format (`jpg` is normalized to `jpeg`).
- An animated GIF, or an image exceeding either Bedrock limit, is normalized to one auto-oriented WebP frame.
- Successful callback result: one SDK `ImageBlock`; the SDK's `FunctionTool` converts it into image content in the tool result.
- Failure: throw an actionable error naming the resolved path and reason. The SDK turns the callback failure into an error tool result, allowing the model to report or recover without terminating the session.

Validation and normalization:

1. Resolve the path.
2. Open/stat it and require a non-empty regular file no larger than 50 MiB.
3. Map the case-insensitive extension to an expected image format.
4. Read the bounded bytes and ask `sharp` for metadata with `limitInputPixels: 100_000_000` and the default first page/frame.
5. Require decoded content to match the expected PNG/JPEG/GIF/WebP format. This supersedes hand-written magic-byte checks and validates that the provider can decode the file.
6. Use `metadata.autoOrient` dimensions (falling back to width/height) to decide whether normalization is needed.
7. If static and within both Bedrock limits, return source bytes unchanged.
8. Otherwise run `sharp(source, { page: 0, pages: 1, limitInputPixels })`, apply `autoOrient()`, resize inside 8000×8000 without enlargement, and encode WebP.
9. Try a bounded quality ladder (`85, 75, 65, 55, 45, 35`); if bytes still exceed the cap, retry bounded 0.8 dimension steps down to a documented minimum edge. Return the first compliant output or an explicit error.

`sharp` is the only new dependency. OCR, URL fetching, S3 access, animation preservation, and terminal rendering are not added. An arbitrary configured model may still lack vision support; that provider rejection remains a normal turn error.

## Permission and Policy

Add `imageViewer` to `classify()` as `kind: 'read'`, with the path in its one-line summary. This makes it:

- statically safe and silent in default/auto modes;
- available in plan mode;
- available in headless mode without a human approval bridge;
- still visible to configured Pre/Post tool hooks, because it is an ordinary tool call.

Unknown tools continue to fail closed. The classification must be added in the same change as registration so a built-in read capability cannot accidentally appear as execute.

## Persistence and Observability

No new persistence format is introduced. SDK messages/session snapshots retain the image tool result according to the SDK's existing media serialization. Trajectory recording continues to serialize SDK events through `toJSON()` and applies its existing field/record caps; large base64 image event data is therefore explicitly truncated in the observer record rather than expanding its budget.

The TUI's existing tool-call display and headless stderr progress records show `imageViewer` like any other tool. Image pixels are not rendered in the terminal.

## Compatibility and Risks

- A configured model without vision/tool-result image support may reject the subsequent model call. Darwin should surface that existing turn failure rather than claiming capability it cannot infer reliably from arbitrary model IDs.
- `sharp` is a native Node-API dependency. It supports the repository's Node >=20 contract, but install/build portability must be verified rather than assumed.
- Compression is lossy and can reduce fine detail. The tool preserves every already-compliant static input and only normalizes when required by provider limits or animation flattening.
- Session and trajectory storage may include image content. This follows existing SDK message persistence semantics and should be documented in the tool contract/spec.
- A symlink to a regular image is readable, like other read tools; relative resolution remains anchored to `projectRoot`, not `process.cwd()`.

## Rollback

Remove the tool from runtime assembly and permission classification, then delete its module/tests. There is no migration or config state to undo; old sessions containing SDK image blocks remain SDK-readable.
