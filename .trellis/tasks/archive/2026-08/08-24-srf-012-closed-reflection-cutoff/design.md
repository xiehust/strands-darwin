# Design — SRF-012 closed reflection cutoff

## Boundary

Keep subject closure inside the bundled read-only locator and workflow instructions. The trajectory recorder, schema, shared reader, replay CLI, SDK loop, and child-management machinery do not change.

## Locator protocol

After strict current/named selection, read the selected file once and parse complete JSONL lines tolerantly. Track:

- the last valid `userInput` for the existing identity preview;
- the last valid `turnEnded` with integer `turn` and `seq` as the inclusive subject cutoff.

If no valid `turnEnded` exists, exit nonzero before printing any successful subject block. Otherwise print explicit `closed-through-turn:` and `closed-through-seq:` fields. Later records remain visible only through `last-user-input:` for current-session identity; they are outside the subject.

## Workflow handoff

The Host keeps locator-before-child ordering and passes session, path, closed turn, and closed seq verbatim. The child may use replay for orientation, but every raw/replay claim, grade, citation, spend sum, and output `record read` range is bounded to records with `seq <= closed-through-seq`. It must verify the cutoff line is the matching `turnEnded` and state the actual bounded first/last seq and turns. No closed turn means no child.

## Verification

Add a filesystem fixture around the real locator covering default open-tail selection, explicit named selection, no closed current/named records, strict missing id, and state/byte hashes before and after. Keep string-contract checks for the bundled instructions and generated dist inspection after build.
