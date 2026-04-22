# Repository Codemap

## Responsibility

`oh-my-opencode-pi` is a pi-native port of the Pantheon orchestration ideas from `oh-my-opencode-slim`.

The repository packages:

- bundled specialist agents and prompt templates
- a pi extension that registers Pantheon tools, commands, and orchestration hooks
- a small installer/onboarding CLI
- bundled coding and repository-mapping skills (`karpathy-guidelines` and `cartography`)
- tests that exercise the extension surface end-to-end
- repository documentation describing how the port differs from upstream

## Entry points

| Path | Role |
|------|------|
| `package.json` | Package manifest and pi extension/skills/prompts registration |
| `bin/oh-my-opencode-pi.mjs` | Standalone installer/verification CLI |
| `extensions/oh-my-opencode-pi/index.ts` | Main extension entrypoint; registers tools, commands, hooks, and UI integrations |
| `agents/*.md` | Bundled Pantheon specialist prompts |
| `prompts/*.md` | Reusable workflow prompt templates |
| `skills/karpathy-guidelines/SKILL.md` | Bundled coding-discipline skill |
| `skills/cartography/SKILL.md` | Bundled repository-mapping skill |

## Directory map

| Path | Responsibility |
|------|----------------|
| [`extensions/oh-my-opencode-pi/`](extensions/oh-my-opencode-pi/codemap.md) | Core extension runtime: config loading, delegation, council, background jobs, adapters, LSP/AST/format tools, UI, stats, workflow state |
| `agents/` | Bundled orchestrator/specialist prompt definitions |
| `prompts/` | Slash-prompt templates like `implement`, `scout-and-plan`, and `ask-council` |
| `skills/` | Bundled prompt skills, including `karpathy-guidelines` for coding discipline and `cartography` for repo mapping |
| `docs/` | User-facing guides mirroring the upstream docs structure, adapted for pi |
| `tests/` | Behavioral coverage for tools, commands, config loading, adapters, multiplexer behavior, and cartography |
| `bin/` | CLI entrypoints for install/verify flows |

## Architecture notes

- The extension is intentionally centralized in `extensions/oh-my-opencode-pi/index.ts`, with focused helper modules for config, specialist metadata/copy, background tasks, debug traces, workflow state, UI rendering, and code tools.
- Config is deep-merged from global and project-local JSON/JSONC files, then sanitized into a typed runtime config.
- Background work is persisted to task artifacts on disk and can optionally surface through tmux panes.
- Research is adapter-based rather than OpenCode-MCP-based.
- `karpathy-guidelines` is a lightweight behavioral skill used to keep implementation work simple, surgical, and verification-driven.
- The cartography skill is the preferred user-facing surface for repo mapping; `pantheon_repo_map` and `pantheon_code_map` are the low-level primitives behind it.

## Typical flow

1. pi loads the extension from `package.json`
2. `index.ts` resolves config, agent registry, and runtime hooks
3. top-level sessions receive orchestrator guidance
4. the orchestrator uses delegate/council/background tools as needed
5. helper modules persist workflow state, debug traces, background logs, and statistics
6. tests validate each major surface independently

## Working notes for future agents

Before changing extension behavior, read:

1. this file
2. `extensions/oh-my-opencode-pi/codemap.md`
3. the relevant docs page in `docs/`
4. the corresponding test file in `tests/`
