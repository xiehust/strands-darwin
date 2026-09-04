# Implementation Plan — Read-only local image tool

1. Add the verified `sharp` dependency through pnpm; do not add `devEngines` or bypass release-age policy.
2. Add `src/tools/image-viewer.ts` with tool/resource constants, project-root path resolution, bounded file read, Sharp metadata/content validation, pass-through for compliant static inputs, bounded WebP normalization, and `ImageBlock` result.
3. Register one project-root-bound `imageViewer` instance in `AgentRuntime.create()` before agent initialization so parent and eligible child catalogues share it.
4. Classify `imageViewer` as a read in `src/agent/permission.ts` and add permission regressions proving default/headless-safe and plan-mode behavior.
5. Add `spike/verify-image-viewer.ts` covering relative/absolute resolution, supported formats and canonical JPEG mapping, exact pass-through, resize/byte compression, EXIF orientation, animated GIF first-frame behavior, SDK image tool-result construction, source/pixel bounds, and validation failures.
6. Add the suite to `spike/run-tests.ts`.
7. Update the Strands SDK contracts spec with measured FunctionTool/ImageBlock/Sharp behavior, limits, error matrix, persistence caveat, and verification command.
8. Run `pnpm tsx spike/verify-image-viewer.ts`, `pnpm tsx spike/verify-permission-modes.ts`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Risky Files and Rollback Points

- `src/agent/runtime.ts`: tool ordering determines child-agent catalogue contents. Keep the change to one import, one construction, and one array entry.
- `src/agent/permission.ts`: forgetting classification turns a read into an approval/plan-mode denial. Cover it explicitly.
- SDK media output can enter snapshots/trajectory. Avoid custom serialization and use the SDK class only.

## Deferred Checks

- A live multimodal Bedrock smoke test can prove model interpretation but is not required for the free test gate; it incurs a model call and should use an inference-profile model ID.
