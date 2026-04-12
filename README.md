# oh-my-opencode-pi

Pantheon-style multi-agent orchestration for pi, inspired by [`oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim).

## What this port includes

This pi package ports the core ideas that make oh-my-opencode-slim useful:

- an **orchestrator-style system prompt** automatically appended in top-level pi sessions
- a **Pantheon delegation tool** for isolated specialist subagents
- specialist agents modeled after **Explorer, Librarian, Oracle, Designer, Fixer, and Council**
- a **Council tool** that runs parallel councillors and synthesizes with a council master
- **custom tool renderers** for Pantheon delegation and council calls/results inside pi
- **background specialist tasks** with status lookup, result retrieval, waiting, and retry
- **model fallback chains** for specialists and council master
- **richer tmux integration** for background task logs and pane attach/reopen
- **external research tools** for the Librarian (`pantheon_fetch`, `pantheon_search`, `pantheon_github_file`, `pantheon_github_releases`, `pantheon_npm_info`, `pantheon_package_docs`)
- **repo cartography / codemap support** via `pantheon_repo_map`
- **structured research adapters** via `pantheon_adapter_list`, `pantheon_adapter_search`, and `pantheon_adapter_fetch`
- **agent-mode UX helpers** like `/pantheon-as`
- **polished TUI command-center UI** for `/pantheon` and interactive selectors
- **compact Pantheon dashboard widget** below the editor for active work context
- **auto-continue workflow** for unchecked todo lists
- **interview/spec generation** via command and tool
- **workflow hints / orchestration nudges** for better specialist routing
- **persisted workflow state** for carrying unchecked todos across turns
- **interactive commands/UI helpers**:
  - `/pantheon`
  - `/pantheon-agents`
  - `/pantheon-council`
  - `/pantheon-config`
- **config validation** with runtime warnings
- a **tolerant edit rescue hook** for pi's `edit` tool when exact `oldText` misses only because of newline/whitespace normalization drift
- workflow prompt templates:
  - `/implement`
  - `/scout-and-plan`
  - `/implement-and-review`
  - `/ask-council`

## What is intentionally not ported

Some oh-my-opencode-slim features are OpenCode-specific and do not map cleanly to pi without much deeper runtime surgery. This port does **not** currently replicate:

- OpenCode agent registry integration
- OpenCode hook/event interception semantics
- `apply_patch` rescue hook
- full MCP parity with every OpenCode integration surface (this port now includes a Pi-native adapter layer with Context7-like docs and grep.app-like code search, but not every original integration)
- background OpenCode session orchestration / tmux multiplexer integration
- interview web UI flow
- OpenCode installer/config mutation

Those can be added later as separate pi extensions, but they are not required for a useful first-class pi port.

## Release / package setup

This repo is now structured as a real pi package.

Included:
- `package.json` with `pi` manifest
- `LICENSE`
- `tsconfig.json`
- `oh-my-opencode-pi.schema.json`
- publish-ready `files` list
- scripts:
  - `npm run typecheck`
  - `npm run pack:dry`

If you want to publish:

```bash
npm publish
```

## Install

### Project-local

```bash
pi install -l /absolute/path/to/oh-my-opencode-pi
```

### Global

```bash
pi install /absolute/path/to/oh-my-opencode-pi
```

Or publish it and install from git/npm as a normal pi package.

## Usage

After install, start `pi` in your project. The main agent behaves like an orchestrator and can call these tools automatically:

- `pantheon_delegate`
- `pantheon_council`

You can also use the bundled prompts:

- `/implement add retry logic to the API client`
- `/scout-and-plan refactor auth boundaries`
- `/implement-and-review improve dashboard filters`
- `/ask-council should we move this module behind an event bus?`

## Available Pantheon agents

List them in-session with:

```text
/pantheon-agents
```

Bundled agents:

- `explorer`
- `librarian`
- `oracle`
- `designer`
- `fixer`
- `council`
- internal: `councillor`, `council-master`

## Overriding agents

The extension loads agents in this precedence order:

1. bundled agents in this package
2. `~/.pi/agent/agents/*.md`
3. project-local `.pi/agents/*.md` when `includeProjectAgents: true`

That means you can override any bundled agent by creating an agent markdown file with the same `name` frontmatter.

## Optional config

Create one of these files:

- global: `~/.pi/agent/oh-my-opencode-pi.json` or `~/.pi/agent/oh-my-opencode-pi.jsonc`
- project: `.pi/oh-my-opencode-pi.json` or `.pi/oh-my-opencode-pi.jsonc`

Both JSON and JSONC are supported. JSONC is useful when you want comments or trailing commas.

Example:

```jsonc
{
  "$schema": "./oh-my-opencode-pi.schema.json",

  // Apply built-in and/or user-defined top-level config presets first
  "extends": ["research", "durable"],

  // Project-local overrides still win after presets are applied
  "appendOrchestratorPrompt": true,

  "agents": {
    "explorer": {
      "model": "anthropic/claude-sonnet-4-5",
      "variant": "high",
      "options": ["--tools", "read,bash"],
      "promptAppendText": "Prefer reconnaissance before broad implementation.",
      "promptAppendFiles": ["./prompts/explorer-project-notes.md"],
      "allowSkills": ["cartography"],
      "allowedAdapters": ["docs-context7", "grep-app", "web-search"]
    },
    "fixer": {
      "model": "openai/gpt-4.1",
      "promptOverrideFile": "./prompts/fixer-override.md",
      "deniedAdapters": ["grep-app"]
    }
  },

  "skills": {
    "setupHints": true,
    "defaultAllow": ["cartography"],
    "cartography": {
      "enabled": true,
      "maxFiles": 250,
      "maxDepth": 4,
      "maxPerDirectory": 8,
      "exclude": ["vendor"]
    }
  },

  "adapters": {
    "disabled": ["github-releases"],
    "defaultAllow": ["docs-context7", "web-search"]
  },

  "council": {
    "defaultPreset": "review-board",
    "masterTimeoutMs": 300000,
    "councillorsTimeoutMs": 180000,
    "presets": {
      "review-board": {
        "master": {
          "model": "anthropic/claude-sonnet-4-5",
          "variant": "high",
          "prompt": "Prioritize correctness and operational simplicity."
        },
        "councillors": [
          {
            "name": "reviewer",
            "model": "anthropic/claude-sonnet-4-5",
            "prompt": "Review from a correctness and edge-case perspective."
          },
          {
            "name": "architect",
            "model": "openai/gpt-4.1",
            "prompt": "Look for architecture risk and maintainability issues."
          },
          {
            "name": "skeptic",
            "model": "google/gemini-2.5-pro",
            "prompt": "Challenge assumptions and suggest simpler alternatives."
          }
        ]
      }
    }
  },

  "fallback": {
    "timeoutMs": 15000,
    "delegateTimeoutMs": 0,
    "retryDelayMs": 500,
    "retryOnEmpty": true,
    "agentTimeouts": {
      "explorer": 120000,
      "librarian": 120000
    },
    "agentChains": {
      "fixer": ["openai/gpt-4.1-mini"],
      "librarian": ["openai/gpt-4.1-mini"]
    },
    "councilMaster": ["openai/gpt-4.1"]
  }
}
```

Schema:
- local copy in this repo: `./oh-my-opencode-pi.schema.json`
- recommended config files:
  - `~/.pi/agent/oh-my-opencode-pi.json`
  - `~/.pi/agent/oh-my-opencode-pi.jsonc`
  - `.pi/oh-my-opencode-pi.json`
  - `.pi/oh-my-opencode-pi.jsonc`

Timeout behavior is now closer to the original `oh-my-opencode-slim` package:
- `fallback.timeoutMs` defaults to `15000` and is used for background-style failover attempts
- `pantheon_delegate` no longer has a hard timeout by default (`fallback.delegateTimeoutMs: 0`)
- you can opt back into foreground limits globally with `fallback.delegateTimeoutMs` or per specialist with `fallback.agentTimeouts`
- council uses longer dedicated timeouts: `council.councillorsTimeoutMs = 180000`, `council.masterTimeoutMs = 300000`

Additional config sections now supported:
- top-level config presets via `preset`, `extends`, and `presets`
- per-agent overrides via `agents.<name>`
  - `model`
  - `variant`
  - `options`
  - `tools`
  - `noTools`
  - `promptOverrideFile`
  - `promptAppendFiles`
  - `promptAppendText`
  - `allowSkills`
  - `denySkills`
  - `allowedAdapters`
  - `deniedAdapters`
  - `disabled`
- deep merge between global and project config
- JSONC parsing for config files
- `council.masterTimeoutMs`
- `council.councillorsTimeoutMs`
- `fallback.timeoutMs`
- `fallback.delegateTimeoutMs`
- `fallback.retryDelayMs`
- `fallback.retryOnEmpty`
- `fallback.agentTimeouts`
- `fallback.agentChains`
- `fallback.councilMaster`
- `background.enabled`
- `background.pollIntervalMs`
- `background.logDir`
- `background.maxConcurrent`
- `multiplexer.tmux`
- `multiplexer.splitDirection`
- `multiplexer.layout`
- `multiplexer.focusOnSpawn`
- `multiplexer.keepPaneOnFinish`
- `research.timeoutMs`
- `research.userAgent`
- `research.maxResults`
- `research.githubToken`
- `research.defaultDocsSite`
- `skills.setupHints`
- `skills.defaultAllow`
- `skills.defaultDeny`
- `skills.cartography.enabled`
- `skills.cartography.maxFiles`
- `skills.cartography.maxDepth`
- `skills.cartography.maxPerDirectory`
- `skills.cartography.exclude`
- `adapters.disableAll`
- `adapters.disabled`
- `adapters.defaultAllow`
- `adapters.defaultDeny`
- `delegation.maxDepth`
- `autoContinue.enabled`
- `autoContinue.cooldownMs`
- `autoContinue.maxContinuations`
- `autoContinue.autoEnable`
- `autoContinue.autoEnableThreshold`
- `interview.templateTitle`
- `workflow.injectHints`
- `workflow.backgroundAwareness`
- `workflow.todoThreshold`
- `workflow.persistTodos`
- `workflow.stateFile`
- `workflow.phaseReminders`
- `workflow.postFileToolNudges`
- `workflow.delegateRetryGuidance`
- `ui.dashboardWidget`
- `ui.maxTodos`
- `ui.maxBackgroundTasks`
- `debug.enabled`
- `debug.logDir`

## Built-in top-level config presets

These top-level config presets can be used via `preset` or `extends`:

- `default` — no extra config changes
- `fast` — lower-overhead council/research defaults
- `research` — stronger librarian/explorer bias and broader docs retrieval defaults
- `durable` — more conservative retry/debug defaults

Project config is deep-merged on top of any selected presets, and project config also overrides global config.

## Built-in council presets

The package now ships with these default presets:

- `default` — 3 councillors
- `quick` — 1 councillor for low overhead second-opinion checks
- `balanced` — 2 councillors for faster trade-off review
- `review-board` — 3 role-shaped councillors (`reviewer`, `architect`, `skeptic`) plus master guidance

You can override any of them in your config.

## Interactive commands

- `/pantheon` — interactive command center with a richer selector UI
- `/pantheon-agents` — list all bundled/user/project Pantheon agents
- `/pantheon-council` — interactive council launcher
- `/pantheon-config` — show config source paths, presets, and validation warnings
- `/pantheon-skills` — show effective skill/cartography guidance plus a starter config snippet
- `/pantheon-repo-map` — render a repo map/codemap summary for the current workspace
- `/pantheon-adapters` — list registered research adapters and effective session policy
- `/pantheon-as <agent> <task>` — direct-route the next task to a specialist
- `/pantheon-auto-continue [on|off]` — toggle auto-continue
- `/pantheon-spec` — interactive interview that loads a markdown spec into the editor
- `/pantheon-backgrounds` — list recent background tasks
- `/pantheon-attach [taskId]` — open/reopen a tmux pane for a background task log
- `/pantheon-cancel [taskId]` — cancel a running background task
- `/pantheon-log [taskId]` — load the tail of a background task log into the editor
- `/pantheon-result [taskId]` — load the final result summary of a background task into the editor
- `/pantheon-retry [taskId]` — retry a finished/failed background task from its saved spec
- `/pantheon-todos` — inspect persisted Pantheon workflow todos/state
- `/pantheon-clear-todos` — clear persisted Pantheon workflow todos
- `/pantheon-overview` — combined workflow + background overview
- `/pantheon-resume` — generate a resume brief from persisted todos and recent background work
- `/pantheon-cleanup` — remove old completed task artifacts
- `/pantheon-debug-dir` — show the foreground debug trace directory
- `/pantheon-debugs` — list recent foreground debug traces
- `/pantheon-debug [traceId]` — load a recent foreground debug trace into the editor

## Background tasks

New tools:
- `pantheon_background`
- `pantheon_background_status`
- `pantheon_background_wait`
- `pantheon_background_result`
- `pantheon_background_retry`
- `pantheon_background_cancel`
- `pantheon_background_log`
- `pantheon_background_attach`
- `pantheon_background_overview`
- `pantheon_workflow_state`
- `pantheon_resume_context`
- `pantheon_auto_continue`
- `pantheon_interview_spec`
- `pantheon_repo_map`

Use these when work should continue detached from the current flow.

Stabilization features now included:
- restart-time reconciliation of stale queued/running tasks
- queued-task auto-start with `background.maxConcurrent`
- richer task status footer updates with queued/running/done/failure counts
- cancellation with PID signaling
- retry from saved task specs
- tmux pane attach/reopen via command/tool
- configurable tmux layout, focus, and keep-pane behavior
- log tail inspection
- cleanup of old finished task artifacts

## Auto-continue workflow

The package can now auto-continue when the assistant leaves unchecked markdown todos like:

```md
- [ ] Investigate bug
- [ ] Add tests
```

If auto-continue is enabled, the extension waits for `autoContinue.cooldownMs` and then sends a follow-up instruction to keep working through remaining unchecked todos.

The extension can also persist the latest unchecked todo list to `workflow.stateFile` so later turns can resume prior work context.

Controls:
- command: `/pantheon-auto-continue [on|off]`
- tool: `pantheon_auto_continue`

Workflow-state controls:
- command: `/pantheon-todos`
- command: `/pantheon-clear-todos`
- command: `/pantheon-overview`
- command: `/pantheon-resume`
- tool: `pantheon_workflow_state`
- tool: `pantheon_resume_context`

## UI polish

The extension now includes a more polished terminal UI layer:
- `/pantheon` opens a command-center style selector instead of a plain prompt list
- interactive task, council-preset, and specialist pickers use a consistent bordered selector UI
- a compact dashboard widget can appear below the editor, surfacing:
  - active/queued background work
  - persisted unchecked todos
  - auto-continue state
  - config warning count
- background/workflow tools render more cleanly inside pi's tool timeline

Dashboard widget config:
- `ui.dashboardWidget` — enable/disable the below-editor dashboard
- `ui.maxTodos` — max persisted todos shown in the widget
- `ui.maxBackgroundTasks` — max active background tasks shown in the widget

## Debugging traces

Foreground delegation and council runs now write persistent debug traces by default.

Default debug directory:
- `.oh-my-opencode-pi-debug/` in the current project
- configurable via `debug.logDir`

Each trace contains structured artifacts such as:
- `summary.json` — top-level trace metadata, params, status, final result summary
- `events.ndjson` — lifecycle events across the whole trace
- per-subagent attempt folders with:
  - `summary.json`
  - `stdout.ndjson`
  - `stderr.log`

Useful commands:
- `/pantheon-debug-dir`
- `/pantheon-debugs`
- `/pantheon-debug`

This makes it possible to inspect failures like `Subagent was aborted` and see whether the cause was:
- timeout
- parent cancellation
- stderr/tool/runtime failure
- fallback-attempt behavior

## Interview/spec workflow

You can generate a structured markdown specification in two ways:
- command: `/pantheon-spec`
- tool: `pantheon_interview_spec`

The command asks interactive questions and loads the generated markdown into the editor.

## External research tools

New tools:
- `pantheon_fetch` — fetch a URL, extract title + readable text
- `pantheon_search` — lightweight web search for external research (`scope`: `web`, `github`, `docs`; optional `site` and `repo` targeting)
- `pantheon_resolve_docs` — resolve likely docs sources for a package, repo, or docs site and optionally search by topic
- `pantheon_fetch_docs` — fetch docs content using package/repo/site-aware resolution instead of only raw URLs
- `pantheon_github_file` — fetch a specific upstream GitHub file
- `pantheon_github_releases` — fetch recent GitHub release notes/changelog history
- `pantheon_npm_info` — inspect npm registry metadata and versions
- `pantheon_package_docs` — fetch package metadata plus README/docs excerpt
- `pantheon_adapter_list` — list the structured adapter registry and effective permissions
- `pantheon_adapter_search` — search through structured adapters such as `docs-context7`, `grep-app`, `web-search`, and `github-releases`
- `pantheon_adapter_fetch` — fetch through a specific adapter with policy enforcement

The bundled `librarian` agent now has access to these tools.

## Repo cartography / skills

The package now includes a Pi-native repository cartography layer:
- `pantheon_repo_map` for quick repo/codemap summaries
- per-agent `allowSkills` / `denySkills` policy fields
- `skills.cartography.*` config for scan limits and excludes
- `/pantheon-skills` for a starter config/setup flow

When cartography is enabled, bundled agents get a prompt hint to use `pantheon_repo_map` during reconnaissance-heavy work.

## Adapter system

The package also includes a lightweight MCP-like adapter registry for structured research:
- `docs-context7` — docs/package/site-aware resolution and fetch
- `grep-app` — public code search against grep.app-style results
- `web-search` — generic fallback search/fetch
- `github-releases` — structured release/changelog retrieval

Policy controls:
- global: `adapters.disableAll`, `adapters.disabled`, `adapters.defaultAllow`, `adapters.defaultDeny`
- per-agent: `agents.<name>.allowedAdapters`, `agents.<name>.deniedAdapters`

Runtime enforcement uses the current Pantheon agent identity for delegated/background specialists, so adapter permissions are not just documentation hints.

## Workflow hints

Runtime resilience additions now included:
- phase reminders for large multi-step work (`scout → plan → implement → verify`, or debug/refactor-specific variants)
- post-file-tool nudges after edit/write/structural-rewrite actions
- delegate/council retry guidance when a foreground specialist run fails
- tolerant JSON/edit recovery and stronger foreground fallback chains

These are configurable under `workflow.phaseReminders`, `workflow.postFileToolNudges`, and `workflow.delegateRetryGuidance`.

## Workflow hints

The extension now injects lightweight orchestration hints into top-level turns to nudge better specialist routing. Examples:
- suggest `librarian` for library/API questions
- suggest `explorer` for reconnaissance tasks
- suggest `oracle` or `pantheon_council` for risky decisions
- remind the orchestrator about active background tasks
- suggest auto-continue for multi-step work
- inject persisted workflow todos from prior work when available
- surface resume context from persisted todos + recent background task history

## Edit rescue behavior

This port includes a lightweight approximation of the `apply_patch` resilience ideas from oh-my-opencode-slim, adapted to pi.

What it does:
- intercepts `edit` tool calls before execution
- rescues edits **sequentially**, so earlier recovered edits inform later ones in the same tool call
- if an `oldText` block is not found exactly, it tries a **unique tolerant match** against the real file
- tolerance includes:
  - CRLF vs LF differences
  - trailing space / tab drift
  - Unicode normalization drift (`NFC`)
  - anchor-based recovery using distinctive first/last meaningful lines
  - distinctive-line signature recovery for repeated/shifted hunks
  - bounded high-confidence fuzzy rescue against nearby line-count windows (not only exact same-sized windows)
- if it finds a safe match, it rewrites `oldText` to the exact current file bytes so pi's native `edit` can succeed

What it does not do:
- it does **not** rewrite ambiguous matches
- it does **not** rescue `write`
- it does **not** do full patch/hunk recovery like the original OpenCode `apply_patch` interception

## Notes

- Top-level sessions get the orchestrator prompt automatically.
- Subagent sessions do **not** get it; they only receive their specialist prompt.
- `pantheon_council` works even without config, but config is how you get true model diversity.
