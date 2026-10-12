# Human and workflow decision recipes

Jev can be a tool you call directly: give it text or JSON plus a narrow question, then inspect the structured answer. An autonomous agent is optional. Think of semantic filtering, routing and rubric scoring alongside ordinary scripts, spreadsheets and review queues.

All recipes below are **Adaptations** for this skill. Links identify reported/prototype precedents, not verified performance for these exact tasks. See [the evidence ledger](community.md) for provenance. No recipe authorizes uploading private data, publishing results, changing accounts or executing external actions.

Adapt these to your own labels and rubric with [Customization](customization.md).
For extraction, annotation, scoring, semantic rules and data workflows, see
[Implementation patterns](implementation-patterns.md).

## How to use a recipe

1. Define the task and labels before seeing results. Include `other`, `insufficient_evidence` or a review path where appropriate.
2. Supply the relevant source text, IDs and your actual policy/rubric. Do not expect the classifier to retrieve current facts or explain its answer in prose.
3. Keep exact matching, date arithmetic, totals and rule enforcement in code. Ask Jev only for the semantic part.
4. Review probabilities and uncertainty. Calibrate thresholds on labeled samples; do not equate model confidence with domain expertise.
5. Preserve source records, send minimal authorized data and save labels separately. Human review remains necessary for consequential outcomes.

**Question notation:** Choice selects one named option; Noul estimates one proposition; Score evaluates an anchored ordinal rubric. These are conceptual questions, not copy-paste API payloads.

## 1. Sort, filter and find

| ID / use | Input | Atomic question / concrete outputs | What you do with it / caveat | Precedent |
|---|---|---|---|---|
| **H01 · Semantic grep** over logs or notes | Numbered text chunks and a precise search criterion | **Noul per chunk:** “Does this describe a user unable to complete checkout?” Require actual inability, not generic payment discussion. | Show matching IDs and source excerpts. Keep a review band and sample discarded chunks; a low score does not prove no incident. | [P04](community.md#p04) |
| **H02 · Support queue routing** | Ticket text, product context and current queue definitions | **Choice:** `billing`, `technical`, `account_access`, `security_review`, `other`; distinguish payment disputes from login failures. | Suggest a queue or send ambiguous/multi-issue tickets to triage. Changing ticket ownership is a separate authorized workflow. | [P04](community.md#p04) |
| **H03 · Urgency screening** | Reported user impact, affected workflow and incident policy | **Score:** 0 = informational; 1 = workaround available; 2 = important work blocked; 3 = critical active impact. | Sort a review queue; code applies known severity rules and escalation deadlines. Jev cannot infer unseen affected-user counts. | [P04](community.md#p04), [R05](community.md#r05) |
| **H04 · Product taxonomy assignment** | Product description and candidate category definitions | **Choice:** `fastener`, `bearing`, `seal`, `electrical_component`, `other`; use a second call for observed subcategories if needed. | Produce reviewable labels. For large taxonomies, use a documented hierarchy/shortlist within API limits; test errors introduced by the first-stage filter. | [R05](community.md#r05), [N03](community.md#n03), [N04](community.md#n04) |
| **H05 · Duplicate/entity matching** | Two records with names, descriptions, locations and provenance | **Noul:** “Do these records refer to the same real-world entity?” Criteria: compatible identity attributes, not just similar names. | Suggest duplicate pairs; retain both records until confirmed. Do not merge people/accounts automatically or infer hidden identity. | Proposed in [R01](community.md#r01) |
| **H06 · Survey/interview coding** | One response and a predefined qualitative codebook | Separate **Noul** questions for `price_concern`, `missing_feature`, `usability_issue`; codes may co-occur. | Export labels with record IDs; audit disagreements with human coders. Do not force multi-label answers into one mutually exclusive Choice. | Adapted from [P04](community.md#p04), [N02](community.md#n02) |
| **H07 · Reading-list/literature screen** | Title, abstract and explicit inclusion criteria | **Noul per criterion:** “Does this study evaluate an agent executing tools?” Distinguish mention from measured study. | Prioritize full-text reading; retain uncertain papers. Abstract screening is not a complete eligibility or quality assessment. | Adapted from [P09](community.md#p09) |

## 2. Evidence, policy and review

| ID / use | Input | Atomic question / concrete outputs | What you do with it / caveat | Precedent |
|---|---|---|---|---|
| **H08 · Claim-to-source check** | One claim and supplied, identifiable source passages | **Noul:** “Do these passages support this exact claim?” Require matching scope, population and conditions. | Flag weakly supported statements for an actual source read. Support is not truth, and no matching evidence is not proof of falsity. | Adapted from [P04](community.md#p04), [P09](community.md#p09), [N02](community.md#n02) |
| **H09 · Policy checklist triage** | One supplied policy requirement and relevant document excerpt | **Choice:** `explicitly_addressed`, `apparently_conflicting`, `not_shown`, `ambiguous`. | Build a review matrix linked to exact excerpts. Qualified reviewers decide compliance; use current authoritative requirements and do not treat classification as legal advice. | Reported pattern [R05](community.md#r05) |
| **H10 · Contract-clause sorting** | Contract clauses and a reviewer-authored taxonomy | **Choice:** `termination`, `liability`, `data_use`, `payment`, `other`. | Group clauses for a legal reviewer; do not autonomously approve a contract or determine enforceability. A document title is insufficient evidence. | Adapted from [R05](community.md#r05), [P04](community.md#p04) |
| **H11 · Editorial/brand checks** | Draft excerpt and one concrete editorial rule | **Noul:** “Does this excerpt make an unsupported superlative claim?” Define exclusions such as attributed quotations. | Flag for human revision. Keep one question per rule; the model supplies no trustworthy explanation merely by selecting a label. | Adapted from [P02](community.md#p02), [P04](community.md#p04) |
| **H12 · Code review shortlist** | Diff, related code and tests, each with stable IDs | **Score per hunk:** 0 = cosmetic; 1 = low-risk behavior; 2 = plausible defect; 3 = potential security/data-loss issue. | Inspect high-priority hunks with compiler/static tools and reviewers. Classifier findings are leads, not proof; do not skip required review for low scores. | [P07](community.md#p07) |
| **H13 · Completion-claim audit** | Status update, acceptance checklist and actual execution receipts | **Noul:** “Does the supplied receipt establish the claimed validation for the current revision?” | Highlight discrepancies for follow-up. Code verifies hashes/timestamps/exit codes; a screenshot or planned command is not execution proof. | [P03](community.md#p03) |
| **H14 · Independent answer comparison** | Same question, relevant source evidence and anonymized candidate answers | **Score per answer:** 0 = unsupported; 1 = partly supported/incomplete; 2 = supported and meets the stated requirement. | Compare disagreement and review samples manually. Counterbalance answer order; do not let models grade their own output as sole ground truth. | Adapted from [P04](community.md#p04), [P09](community.md#p09), [N01](community.md#n01) |

## 3. Operations and business workflows

| ID / use | Input | Atomic question / concrete outputs | What you do with it / caveat | Precedent |
|---|---|---|---|---|
| **H15 · Conversation concern prefilter** | Authorized, redacted transcript and a precisely defined concern | **Noul:** “Does this conversation contain an unresolved product-safety complaint?” Show what counts as unresolved. | Send positives/uncertain cases to a reviewer or larger model. Measure missed concerns; do not claim a low score means the conversation is safe. | Reported pattern [R05](community.md#r05) |
| **H16 · Customer churn signals** | Customer message and limited relevant account history | **Noul:** “Does this message express a concrete intent to cancel because of an unresolved issue?” Distinguish hypothetical discussion. | Prepare a support follow-up queue; no automatic retention offers or account changes. Protect customer data and audit language/domain bias. | [P04](community.md#p04) |
| **H17 · Sales/support next-step suggestion** | Call transcript, promised actions and permitted follow-up types | **Choice:** `send_requested_docs`, `schedule_followup`, `technical_investigation`, `no_commitment`, `clarify`. | Draft an action list with source references; a human verifies commitments and authorizes contact. Classification must not invent a promise. | Proposed in [R05](community.md#r05) |
| **H18 · Security incident triage** | Redacted incident text and an explicit escalation policy | **Choice:** `possible_account_takeover`, `service_issue`, `benign_change`, `insufficient_evidence`. | Route for investigation; deterministic rules handle known high-risk indicators. Do not disable accounts solely on an uncalibrated model score. | [P04](community.md#p04) |
| **H19 · Suspicious message screening** | Message body, displayed sender and observed link metadata; no credentials | **Noul:** “Does this message solicit credentials or payment through suspicious instructions?” | Flag for human review without opening links or attachments. Avoid both a universal spam threshold and a “safe to click” certification. | Adapted from [P04](community.md#p04) |
| **H20 · Form/inquiry routing** | Contact form and allowed inquiry-category definitions | **Choice:** `support`, `sales`, `partnership`, `feedback`, `spam_or_other`. | Generate queue labels or draft replies; sending is separate. Keep unrecognized legitimate requests accessible rather than silently discarding them. | Adapted from [P04](community.md#p04) |
| **H21 · Job-requirement evidence organization** | User-authorized résumé text and one job-related requirement | **Choice:** `explicit_evidence`, `related_evidence`, `not_stated`; criteria require supplied text. | Help a person locate evidence, not rank or reject candidates. Do not infer protected traits, assess character or equate unstated with absent ability. | Proposed in [R08](community.md#r08) |

## 4. Personal, data and creative tools

| ID / use | Input | Atomic question / concrete outputs | What you do with it / caveat | Precedent |
|---|---|---|---|---|
| **H22 · Dataset curation** | One record and an explicit intended-use rubric | **Score:** 0 = irrelevant/unusable; 1 = partially useful; 2 = directly useful and coherent. Ask separate Nouls for duplication or sensitive-data concerns. | Keep original rows and sidecar scores; audit rejected examples and distribution shifts. Coherence does not establish mathematical correctness or license suitability. | [P08](community.md#p08), [N02](community.md#n02) |
| **H23 · Search-result reranking** | Query and retrieved document candidates with IDs | **Noul per result:** “Does this document address the user's specific question?” | Reorder a shortlist, preserving citations and the original ranking. Evaluate by corpus; a general classifier may lose to a dedicated reranker. | [P09](community.md#p09), [N03](community.md#n03) |
| **H24 · Personal inbox/event sorting** | Authorized message text and calendar-related criteria | **Choice:** `new_event_candidate`, `event_change`, `reminder_only`, `not_an_event`, `ambiguous`. | Create draft event candidates. Parse dates/time zones separately and confirm conflicts; never add calendar items or invite people without authority. | Proposed in [R01](community.md#r01) |
| **H25 · Idea workshop** | Idea description and a rubric defined by the person using the tool | Separate **Scores** for problem clarity, audience specificity and testability: 0 = absent; 1 = vague; 2 = concrete. | Calculate summaries in code, then plan actual interviews/tests. These are discussion prompts, not forecasts of business success or investment advice. | [P10](community.md#p10) |
| **H26 · Smart-home intent resolution** | User request, observed devices and currently allowed harmless actions | **Choice:** `living_room_light_on`, `living_room_light_off`, `no_match`, `clarify`; include room ambiguity. | Display or execute only pre-authorized low-risk actions through the home controller. Locks, alarms and hazardous appliances need separate strict controls. | Proposed in [R09](community.md#r09) |
| **H27 · Game/NPC choice assistant** | Visible game state, character rubric and legal candidate actions | **Choice:** `offer_help`, `retreat`, `negotiate`, `wait`; score alignment with the stated character, not hidden game state. | Use the chosen action in a private simulation or authored game; evaluate player experience. This is not general planning or a real-world robotics safety policy. | Proposed in [R03](community.md#r03); demo pattern [R10](community.md#r10), [X01](twitter-workflows.md#x01), [X03](twitter-workflows.md#x03) |
| **H28 · Reusable document-component selection** | Structured content, audience and fixed component definitions | **Choice:** `comparison_table` (parallel attributes), `timeline` (dated sequence), `checklist` (actions), `paragraph` (narrative), `none`. | Local code renders the chosen component; a person reviews it. This is selection, not text/image generation; escape all untrusted input. | Adapted from the UI-selection lead in [R12](community.md#r12) |

## Worked example: policy review without pretending to be a lawyer

A reviewer supplies the current policy and three explicit requirements. The tool is allowed to classify the supplied excerpts, not fetch new law, make legal conclusions or publish a compliance badge.

1. Assign immutable IDs to requirements and relevant excerpts. Preserve original text and source dates.
2. Ask **H09** separately for each requirement. An option such as `not_shown` prevents the model from forcing absence of evidence into a legal violation.
3. Save each raw response with the requirement and excerpt IDs. Use labels to order a review queue.
4. A reviewer opens the source passages and resolves exceptions, definitions and missing context. Unclear cases remain unresolved.
5. If a larger model drafts a summary, ask **H08** only whether each summary claim is supported by the supplied sources. That check still does not establish legal correctness.

A useful pilot measures missed issues, false flags, reviewer corrections and time spent, alongside cost. “The classifier returned a label” is not “the policy complies.”

## When a simpler tool is better

Use code or a database for exact IDs, arithmetic, date comparisons, schema validation and rules with no semantic ambiguity. Use search for missing facts and a reasoning model or human for multi-step analysis. Avoid Jev when transmission is unauthorized, labels cannot be specified, the state omits decisive evidence, or no one can review consequential errors. You do not need an agent framework to use any of the bounded screening recipes above.
