# X/Twitter workflows: composing a decision model with other tools

Research snapshot: **2026-09-20**. These are use-case precedents and adaptation
ideas, not integrations installed by this skill or reproduced performance results.
X is a first-class research source alongside Reddit, repositories and articles.
Follow a post to its implementation when available; count reposts as one claim.

The later [29-post user collection](x-intake-2026-09-20.md) is fully indexed
separately, including WebMCP, context-pressure-aware compaction, strategic/tactical
control, Stagehand primitives, conversation choreography and TTS style selection.
It preserves the supplied excerpts' status and adds primary-document follow-up.

## Access and evidence

Direct retrieval of the first four linked X posts returned HTTP 403. The whale-city
post's text was readable on the author's [public profile mirror](https://twstalker.com/gokayfem).
Entries X02–X07 below were discovered as author-post excerpts in
[Jevable](https://jevable.com/); some excerpts are truncated. Original post URLs
are retained for follow-up, but are **not a claim of direct X access**. We did not
inspect these demos' source code, watch their full videos or run their systems.
[Made with Jev](https://madewithjev.com/) is another discovery index, not an
independent verification of its listed claims.

<a id="x01"></a>

## X01 — World designer + action selector + video renderer

**Author report / demo:** @gokayfem describes a game about keeping a city on a
whale alive. GPT-6 Astra designed the world, Jev selected actions, and H3 Max
Turbo on fal rendered one decision from each round. The author reports roughly
five minutes for Jev decision-making and video generation, producing 264 clips.

[Original post](https://x.com/gokayfem/status/2101022590722810271) ·
[Readable author-text mirror](https://twstalker.com/gokayfem) ·
[Discovery entry](https://jevable.com/project/2101022590722810271)

**What the text does not establish:** exactly 264 API calls, the number of
questions/actions per round, sequential versus parallel execution, per-turn
latency, world-design time, cost, win rate, calibration, or independent quality
assessment. The five-minute claim is not a measured result of this repository.
Do not relabel aggregate throughput as verified real-time closed-loop control.

### Transferable design, not a reconstruction of the author's code

```text
Human or generative model authors world rules, objectives and possible actions
  → host exposes current structured state and currently legal candidates
  → Jev selects an action using the chosen objective / character rubric
  → simulator validates and applies the transition
  → renderer presents the resulting state
  → next decision uses the updated authoritative state
```

Keep state transitions independent from decorative video: a generated image of a
repaired bridge is not evidence that the simulator repaired it. A renderer can
lag behind the decision loop; attach round/state IDs and present clips in order.
If the next action depends on what was actually rendered, wait for and inspect
that observation instead of assuming the intended frame appeared.

**Customization knobs:** authored world, objective, character preferences, legal
actions, time horizon, stop conditions, human overrides and presentation medium.
The same pattern can support an NPC, branching story, learning simulation,
resource-management game or a visual replay of an agent run. These extensions are
our proposed adaptations, not additional claims about the showcased project.

**Agent use:** the agent builds a task-specific controller and delegates bounded
choices to Jev, retaining execution and outcome checks in the host.
**Human-tool use:** a person changes the scenario or policy, inspects alternatives,
overrides a choice and compares trajectories. Video is optional; a table or text
replay can be enough. None of this requires training or fine-tuning Jev.

**If testing it:** compare policies on the same worlds/seeds and legal action
space. Record survival/objective outcomes, invalid actions, deadlocks, calls,
costs and latency separately from rendering time. Test decision quality without
video first; attractive output should not become the success metric.

## More X leads, and what to customize

The short **reported** descriptions below come only from the directory excerpts;
the adaptation column is our design suggestion. These leads broaden the method
library without claiming source-inspected or production-ready implementations.

| ID / original author post | Reported in the excerpt | Proposed customization / consumption |
|---|---|---|
| <a id="x02"></a> **X02 · [JevForm / @tamirspiritt](https://x.com/tamirspiritt/status/2101079101997982037)** | A branching form chooses the next question and uses Vercel json-render. | Supply answered fields, missing information and permitted next questions; select ask/clarify/finish. Customize completion criteria; ordinary code still validates required fields. |
| <a id="x03"></a> **X03 · [OpenCode Tetris / @tanaysoni_](https://x.com/tanaysoni_/status/2101020844092756072)** | OpenCode reads browser-game controls, uses GPT-6 to build a Jev controller, then hands off play. | Adapt to different observed interfaces and legal controls. Discover the action space instead of assuming every application accepts the same moves. |
| <a id="x04"></a> **X04 · [Predictive spreadsheets / @dabit3](https://x.com/dabit3/status/2100780008193020049)** | A typed column heading changes how rows are semantically rated. | Turn a user's heading into explicit, editable rubric anchors before repeated scoring; version the rubric, debounce typing and invalidate stale results. |
| <a id="x05"></a> **X05 · [Your Signal / @FabioAngela79](https://x.com/FabioAngela79/status/2101013867627159592)** | Scores visible posts and applies personal rules locally; described as reversible and open source. | Separate reusable judgments from user weights/hide rules. Reweight without another call only when evidence and question meaning are unchanged; retain an undo path. |
| <a id="x06"></a> **X06 · [Catan / @sachpatro97](https://x.com/sachpatro97/status/2101064273187274838)** | Multiple Jevs reportedly stop negotiating and make no progress. | Include legal pass/terminate paths, negotiation budgets and deadlock detection. Local plausible choices do not guarantee progress by the group. |
| <a id="x07"></a> **X07 · [Creative-model routing / @higgsfield_ai](https://x.com/higgsfield_ai/status/2101022133753430365)** | A demo selects image/video generation models from a prompt. | Provide current candidate capabilities, user constraints and availability; route first, then invoke the chosen generator. Evaluate output quality and cost, not routing confidence alone. |

Directory entries for retrieving the observed excerpts:
[X02](https://jevable.com/project/2101079101997982037),
[X03](https://jevable.com/project/2101020844092756072),
[X04](https://jevable.com/project/2100780008193020049),
[X05](https://jevable.com/project/2101013867627159592),
[X06](https://jevable.com/project/2101064273187274838),
[X07](https://jevable.com/project/2101022133753430365).

## How to ingest the next useful post

Record the original URL, author, access path and relevant claim. Ask what the
model sees, what it chooses, what consumes the choice, and what users can change.
Keep explicit unknowns when a demo omits these details. Promote a discovery lead
to source-inspected only after reading its implementation; promote a performance
claim to reproduced only after running a comparable test with receipts.

Use [Customization](customization.md) to design a new request and
[Implementation patterns](implementation-patterns.md) to connect it to a host.
These examples should expand possible designs, not become mandatory presets.
