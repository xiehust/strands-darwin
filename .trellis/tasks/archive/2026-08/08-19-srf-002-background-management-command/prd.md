# SRF-002 tolerate redundant background management command

## Goal

Avoid wasting a model turn when a valid background `status`, `output`, or `stop` call also
contains a redundant `command` copied from an earlier bash call.

## Requirements

- Accept an optional `command` only for `status`, `output`, and `stop`, then ignore it and use
  only the required `taskId` for the manager call.
- Preserve validation for `list.command`, forbidden timeouts, missing task ids, and forbidden
  task ids on `start`/`list`.
- Preserve execute/start/restart compatibility, foreground delegation, permission
  classification, hooks, and process lifecycle behavior.
- Do not execute the redundant string or reinterpret it as a task id.
- Keep the provider-facing schema as one top-level Zod object for Bedrock compatibility.
- Preserve the Host-owned `in-progress` lifecycle status for SRF-002 in the research backlog.

## Acceptance Criteria

- [x] Focused deterministic assertions show `status`, `output`, and `stop` return the same
  manager result and pass the same `taskId` with or without a redundant `command`.
- [x] The redundant string is neither executed nor forwarded as an alternate identifier.
- [x] `list` still rejects `command`; all existing field/mode and foreground delegation checks
  remain green.
- [x] `spike/verify-background-bash.ts`, `pnpm typecheck`, `pnpm test`, `git diff --check`,
  Trellis validation, and the AGENTS.md 32 KiB size check pass.
- [x] The task is archived and the accepted-ready result is committed without changing SRF-002
  from `in-progress` to `done`.

## Origin

- `docs/reflections/reflection_2026-08-19_session-20260819-075248263.md`, trajectory seq
  191/192 with corrected call at 194/195.
- `docs/research/backlog_index.md`, direction SRF-002.
