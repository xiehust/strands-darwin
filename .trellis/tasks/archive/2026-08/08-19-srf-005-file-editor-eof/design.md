# Design

## Extension seam

Patch the pinned SDK vended `file-editor` implementation. `src/agent/runtime.ts` imports the SDK's
singleton `fileEditor` directly and supplies it to both the parent and child tool catalogues. A
Darwin wrapper would duplicate the provider-facing schema or intercept/rewrite output; neither is
smaller than changing the SDK's private `applyViewRange()` function. The repository already owns
`patches/@strands-agents__sdk@1.12.0.patch`, so extend that version-pinned patch and leave runtime
assembly, permissions, paths, edit diffs, and write commands untouched.

## Range normalization

Keep the SDK's existing validation order and output path. After validating the start, derive an
`effectiveEnd`:

- `-1` remains the EOF sentinel;
- a positive end above `nLines` becomes `nLines` for non-empty regular text;
- every other end remains unchanged.

Use `effectiveEnd` for the existing start/end ordering check and slice. Preserve the empty-file
path exactly, including its current split/output and oversized-range failure, because empty-file
behavior is explicitly outside this direction. Missing paths, directories, decoding, size checks,
and all write handlers remain before/after the unchanged range helper boundary.

## Verification seam

Add `spike/verify-file-editor.ts`, an offline suite using the exported SDK tool's `toolSpec` and
`stream()` provider path with the SDK's real local sandbox and temporary real files. Compare exact
output strings for oversized, sentinel, and in-range requests; compare bytes and file metadata
before/after reads; parse numbered rows to prove each source line appears once. Pin explicit errors
for invalid starts/endpoints/order and unchanged behavior for empty, directory, missing, binary,
and oversized files. Also inspect that provider schema and write-command declarations are
unchanged.
