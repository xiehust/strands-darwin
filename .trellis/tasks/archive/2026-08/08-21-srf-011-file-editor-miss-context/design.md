# Design

## Extension seam

Patch the pinned SDK vended `dist/src/vended-tools/file-editor/file-editor.js` zero-occurrence
branch in `buildStrReplaceResult()`. This branch runs only after path validation, sandbox read, and
the existing 1 MiB limit, but before `handleStrReplace()` can call `sandbox.writeText()`. It is the
smallest seam that can preserve the SDK singleton, provider schema, sandbox ownership, exact
mutation semantics, and all unrelated errors.

## Deterministic bounded candidate search

Recovery is advisory only. Keep exact occurrence counting unchanged. When it returns zero:

1. Refuse advisory matching if `old_str` is empty or exceeds 8,192 Unicode code points. Check the
   UTF-16 length first, so a huge input can be refused without traversing all of it. The exact miss
   remains the first error sentence and the advisory section states why context was not selected.
2. Convert accepted current text and `old_str` to code-point arrays so no excerpt or probe splits a
   surrogate pair. The file has already passed the existing 1 MiB UTF-8 limit.
3. Derive at most 64 evenly spaced exact seed fragments from `old_str`. Seed width is clamped to
   8–64 code points (`floor(oldLength / 4)`), and whitespace-only seeds are skipped. Search at most
   16 occurrences of each seed, so candidate evidence is capped at 1,024 matches and at most 64
   scans of an already size-limited file.
4. Each seed occurrence projects a possible replacement start (`currentOffset - oldSeedOffset`).
   Group equal projected starts. Rank groups by distinct query code-point coverage, then seed count,
   then earliest current occurrence. A group is useful only when its exact seed union covers at
   least `max(12, min(128, ceil(oldLength / 3)))` code points. Ties therefore choose the earliest
   current location deterministically.

The seed-union strategy targets localized stale edits and tolerates a changed/inserted/deleted span
without performing edit-distance work. It intentionally refuses short, weak, or wholly changed
inputs rather than making arbitrary text look authoritative. Seed matches select advisory context
only; neither a seed nor its projected start is ever used to mutate. If no group passes, the result
explicitly says no safe useful close match was found.

## Advisory excerpt

Map the selected code-point offset back to its current line. Return that line plus at most two lines
before and after (five lines total), in existing six-column line-number style. Each displayed line is
capped at 240 Unicode code points and gets an explicit `… [line truncated]` suffix when shortened.
If the file has undisplayed lines before or after, state the omitted line counts. The section begins
with `Advisory context only; no fuzzy replacement was attempted` so it cannot be mistaken for a
successful edit. The original exact-miss sentence remains unchanged ahead of the advisory section.

## Compatibility and verification

Regenerate the existing pnpm patch rather than editing Darwin runtime code. Focused tests invoke the
real exported tool through `stream()` against real files and count the sandbox write primitive.
They pin near-match recovery, absence, deterministic ambiguity, caps, Unicode, unchanged bytes and
metadata on misses, exact success, and unrelated error strings. Patch syntax and clean reapplication
are checked after regeneration.
