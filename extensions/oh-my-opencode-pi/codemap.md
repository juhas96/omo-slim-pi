# Extension Codemap

## Responsibility

`extensions/oh-my-opencode-pi/` contains the runtime implementation of the Pantheon pi port.

This is where the package turns prompts and configuration into actual pi commands, tools, hooks, background sessions, and debugging artifacts.

## Key files

| Path | Responsibility |
|------|----------------|
| `index.ts` | Main extension entrypoint. Registers Pantheon tools and commands, attaches hook behavior, coordinates delegation/council/background flows, and renders runtime status. |
| `config.ts` | Loads global and project config, resolves presets, validates option shapes, and computes agent skill/adapter policy. |
| `agents.ts` | Discovers bundled, user, and project-local agents and applies prompt/model/tool overrides. |
| `background.ts` | Detached task lifecycle: queueing, task files, reconciliation, tmux pane attach/reuse, retry, cancellation, summaries. |
| `background-runner.mjs` | Separate process entrypoint for executing background jobs. |
| `orchestration.ts` | Internal orchestration runtime snapshot and summary helpers. |
| `workflow.ts` | Todo extraction/persistence, resume context, and orchestration hints. |
| `ui.ts` | TUI helper rendering for selectors, dashboards, tool timeline output, and status chips. |
| `debug.ts` | Persistent foreground debug traces and per-subagent artifacts. |
| `stats.ts` | Usage/failure accounting for tools, categories, adapters, and background outcomes. |
| `smartfetch.ts` | Docs-aware web fetch helper: llms.txt probing, redirect safety, and HTML main-content extraction. |
| `update-checker.ts` | Package version check cache, npm registry lookup, and low-noise update reporting helpers. |
| `setup.ts` | Bootstrap scaffolding and spec-template generation helpers. |
| `hooks/fallback.ts` | Timeout/fallback model resolution for delegate/council/background attempts. |
| `hooks/json-recovery.ts` | Tolerant `edit` rescue and JSON-ish recovery behavior. |
| `tools/*.ts` | Concrete tool implementations for LSP, formatting, patch application, AST-grep, repo maps, and code maps. |

## Design patterns

### Central registry + helper modules

`index.ts` is the composition root. It wires together smaller modules rather than burying all behavior inline.

### Config-driven orchestration

Most runtime behavior is steered through `PantheonConfig`, including:

- model overrides
- fallback behavior
- council presets
- adapter access
- skill access
- background limits
- tmux behavior
- debug and workflow persistence
- package update check behavior

### Persistent detached work

Background execution is file-backed. Task specs, logs, and results live on disk so sessions can be rejoined, retried, or inspected later.

### Policy-aware research

External research is controlled through adapter policy resolution rather than assumed global availability.

## Flow

### Delegation / council

1. `index.ts` receives a tool or command request
2. config and agent policy are resolved
3. debug trace context is initialized
4. subagent runs are launched directly or in parallel
5. outputs are summarized back into pi tool results

### Background work

1. a background task spec is created
2. task metadata/log/result files are written
3. a detached runner process is launched
4. reconciliation updates stale/running/completed state
5. optional tmux panes surface live logs

### File/code tools

Tool modules under `tools/` provide focused implementations for:

- code navigation and rename flows
- formatting / organize imports
- AST-grep search and replace
- repo/code mapping
- patch application

## Integration boundaries

- depends on pi runtime APIs for extension registration and hooks
- depends on local filesystem state for config, workflow, stats, and background persistence
- depends on optional tmux availability for multiplexer panes
- depends on provider/model strings supplied by the user's pi setup

## Change-risk hotspots

Be especially careful in:

- `index.ts` — broad fan-in and behavior surface
- `config.ts` — compatibility and validation behavior
- `background.ts` — detached process management and pane orchestration
- `tools/lsp.ts` and `tools/patch.ts` — correctness-sensitive editing/navigation behavior
