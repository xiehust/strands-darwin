# State Management

> How state is managed in this project.

---

## Overview

<!--
Document your project's state management conventions here.

Questions to answer:
- What state management solution do you use?
- How is local vs global state decided?
- How do you handle server state?
- What are the patterns for derived state?
-->

(To be filled by the team)

---

## State Categories

<!-- Local state, global state, server state, URL state -->

(To be filled by the team)

---

## When to Use Global State

<!-- Criteria for promoting state to global -->

(To be filled by the team)

---

## Server State

<!-- How server data is cached and synchronized -->

(To be filled by the team)

---

## Common Mistakes

<!-- State management mistakes your team has made -->

(To be filled by the team)

## Stream-interruption continuation ownership (SRF-001)

`App.runTurn` owns one busy interval for the original attempt plus its one possible continuation. The
first failed attempt dispatches `turnEnded`, an error notice, then a continuation warning before the
second ordinary `runtime.send`; it does **not** set status idle, clear the busy clock, mark
`turnAborted`, drain queued prompts, or return queued prompts to the editor. Only final success runs
post-turn checks and ordinary queue drain. Cancellation or the continuation's failure follows the
existing abort path exactly once and returns queued user work unsent. The internal continuation
prompt is never dispatched as typed `userInput` and never enters prompt recall; trajectory recording
still records it as the actual second model input.
