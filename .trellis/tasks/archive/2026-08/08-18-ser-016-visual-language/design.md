# Design

## Visual language

Introduce a small `src/tui/visual-language.ts` module containing named semantic colors, transcript markers, and compact labels. Colors support hierarchy, but stable ASCII/Unicode text carries every critical distinction when ANSI is stripped.

## Surface changes

1. `Header` becomes a compact status card: Darwin identity and live state lead; model/session and policy remain observable; loaded skills/tools are summarized by count rather than enumerated. Header height is checked against the previous baseline at representative widths.
2. Transcript rows share explicit markers for user, Darwin, tool, and notices while retaining the existing `HistoryEntry` and `AnswerPart` layout behavior.
3. The composer uses a persistent active marker/border vocabulary and a high-contrast textual selection marker in slash/path menus. No editor geometry or key branch changes.
4. Active/completed tools and the permission modal use the same state/risk roles. Permission content and bounded-row planning remain information-equivalent.

## Verification

Add a deterministic Ink render suite for header, transcript, composer/menu, tool state, and modal. Assert ANSI-stripped markers and header row non-growth. Reuse existing frame-budget/unit suites, then run required free PTY scenarios and the live approve scenario after source settles.
