# Jev installation

- Source: https://github.com/wuyoscar/jev-skill
- Published release: `v0.2.0`
- Source commit: `82c01055c80fa96d3e8a1b82132361693b6bf3a1`
- Host/scope: Darwin, project-local `.darwin/skills/`
- Selected mode: real Jev (`jev_api`), provider `openrouter`
- Bundled model: `typesafe/jev-1.13`
- License: upstream MIT notice in `jev-LICENSE`

The eleven complete skill folders are unmodified release copies: `jev`,
`jev-code-review`, `jev-context`, `jev-documents`, `jev-find-code`, `jev-redteam`,
`jev-route`, `jev-setup`, `jev-simulation`, `jev-triage`, and `jev-ui`.
The `jev-simulation` skill supplies simulation/game scenarios; installing it
is not a switch from the selected real-service mode to agent simulation.

The shared `jev-decide` CLI was installed with `uv tool install` from the same
pinned source. That user-local executable is not supplied by this repository.
Use `--provider openrouter` explicitly; never switch services on an API error.
This note records the selection; it is not a runtime configuration file.

Installation was verified offline: release-byte comparison, entrypoint links,
ten OpenRouter dry-runs, and discovery/slash expansion through Darwin's installed
skills plugin. No Jev request or credential authentication was performed.

Before live use, configure `OPENROUTER_API_KEY` privately in Darwin's launch
environment. The user must explicitly allow that name in `shellEnv.passthrough`
in `~/.darwin/config.json`, preserving existing entries, and restart Darwin.
Do not store the key here or in chat. Installation is not approval to send data
or spend API credits. Restart Darwin to refresh the installed skill catalogue.
