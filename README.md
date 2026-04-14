<div align="center">
  <h1>oh-my-opencode-pi</h1>
  <p><i>Pantheon-style multi-agent orchestration for pi.</i></p>
  <p>
    <img src="https://img.shields.io/badge/pi-package-6C47FF?style=for-the-badge" alt="pi package">&nbsp;
    <img src="https://img.shields.io/badge/Pantheon-multi--agent-111111?style=for-the-badge" alt="Pantheon multi-agent">&nbsp;
    <img src="https://img.shields.io/badge/docs-upstream--style-0A7EA4?style=for-the-badge" alt="docs upstream style">
  </p>
  <p><b>Pi-native Pantheon port</b> · specialist delegation · council synthesis · background execution · repo cartography</p>
  <p><sub>Inspired by <a href="https://github.com/alvinunreal/oh-my-opencode-slim"><code>oh-my-opencode-slim</code></a>, adapted for pi's runtime, hooks, tools, and extension model.</sub></p>
</div>

---

## 📦 Installation

### Quick start

Project-local install from npm:

```bash
pi install -l npm:oh-my-opencode-pi
```

Global install from npm:

```bash
pi install npm:oh-my-opencode-pi
```

You can also pin a version explicitly:

```bash
pi install -l npm:oh-my-opencode-pi@<version>
```

Standalone installer / bootstrap CLI:

The generated config includes explicit OpenAI defaults for delegated specialists and a `review-board` council preset. The top-level pi session model still comes from pi itself.

Prerequisites for a successful first run:

- pi is installed and can load the package
- at least one provider is configured in pi
- tmux is only needed if you want multiplexer/background-pane features

```bash
npx oh-my-opencode-pi install --cwd /path/to/project --tmux=yes --skills=yes
npx oh-my-opencode-pi verify --cwd /path/to/project
```

If you installed the package globally and have the binary on your `PATH`, you can run `oh-my-opencode-pi ...` directly.

### ✅ Verify your setup

Open `pi` in the target project, then run:

```text
/pantheon
/pantheon-config
/pantheon-doctor
```

If those commands resolve, the extension is loaded and the Pantheon surface is available.

### 🚀 Start here in 3 minutes

Use Pantheon from the outside in:

1. **Open the launcher**
   ```text
   /pantheon
   ```
   The default launcher now stays focused on a small set of jobs: **start work**, **review**, **resume**, **tasks**, and **troubleshooting**. Lower-frequency setup and diagnostics live behind an **Advanced** path.

2. **Try one bounded task**
   - choose **Start work · Delegate to specialist**
   - ask Explorer or Fixer a small, concrete question

3. **Inspect the result**
   - Pantheon writes a structured report into the editor
   - non-interactive commands keep their output in the editor + compact widget below the editor
   - interactive delegation flows can also add a labeled chat result when that helps preserve the prompt/response trail

4. **Try one background workflow**
   - start detached work with `pantheon_background`
   - use `/pantheon-task-actions` as the primary task inspector/recovery menu
   - drop into advanced task commands only when you specifically need `/pantheon-watch`, `/pantheon-result`, or tmux attach behavior

### 👀 What you'll see in the TUI

Pantheon uses a few consistent surfaces:

- **Command widget** — short result/status line below the editor
- **Editor report** — full command output for inspection and copy/paste
- **Chat report** — used only for interactive command flows where a timeline entry is useful
- **Dashboard widget** — the current next-best action, active work, and warnings
- **Subagent widget** — live delegate/council activity while specialists run

### Helpful first actions

```text
/pantheon                 # simplified command center
/pantheon-council         # high-confidence multi-model decision
/review                   # structured review helper
/pantheon-task-actions    # inspect/retry/cancel/attach from one task menu
/pantheon-doctor          # setup/runtime health checks
```

### Detailed guides

- [Installation Guide](docs/installation.md)
- [Provider Configurations](docs/provider-configurations.md)
- [Configuration Reference](docs/configuration.md)
- [Quick Reference](docs/quick-reference.md)

---

## 🏛️ Meet the Pantheon

### 01. Orchestrator — The Embodiment of Order

| Field | Details |
|------|---------|
| **Role** | Master delegator and strategic coordinator |
| **Prompt** | [`agents/orchestrator.md`](agents/orchestrator.md) |
| **Behavior** | Appends top-level orchestration guidance, chooses when to act directly, delegate, use council, or launch background work |
| **Best at** | Routing, sequencing, balancing speed/quality/cost |

### 02. Explorer — The Eternal Wanderer

| Field | Details |
|------|---------|
| **Role** | Codebase reconnaissance |
| **Prompt** | [`agents/explorer.md`](agents/explorer.md) |
| **Best at** | Finding files, summarizing architecture, locating patterns, mapping unfamiliar areas |
| **Ideal tools** | `read`, `bash`, `pantheon_repo_map`, `pantheon_code_map` |

### 03. Oracle — The Guardian of Paths

| Field | Details |
|------|---------|
| **Role** | Strategic advisor and debugger of last resort |
| **Prompt** | [`agents/oracle.md`](agents/oracle.md) |
| **Best at** | Risky decisions, architecture review, simplification, hard debugging |
| **When to use** | Expensive-to-reverse choices and persistent bugs |

### 04. Council — The Chorus of Minds

| Field | Details |
|------|---------|
| **Role** | Multi-model consensus and synthesis |
| **Prompt** | [`agents/council.md`](agents/council.md) |
| **Guide** | [`docs/council.md`](docs/council.md) |
| **Best at** | Ambiguous trade-offs, high-confidence review, architecture verdicts |

### 05. Librarian — The Weaver of Knowledge

| Field | Details |
|------|---------|
| **Role** | External knowledge retrieval |
| **Prompt** | [`agents/librarian.md`](agents/librarian.md) |
| **Best at** | Docs lookup, package research, release notes, upstream examples |
| **Research surface** | Fetch/search tools plus the adapter system documented in [`docs/mcps.md`](docs/mcps.md) |

### 06. Designer — The Guardian of Aesthetics

| Field | Details |
|------|---------|
| **Role** | UI/UX implementation and review |
| **Prompt** | [`agents/designer.md`](agents/designer.md) |
| **Best at** | Interface polish, interaction quality, visual cleanup, frontend ergonomics |
| **When to use** | User-facing work where presentation quality matters |

### 07. Fixer — The Last Builder

| Field | Details |
|------|---------|
| **Role** | Fast implementation specialist |
| **Prompt** | [`agents/fixer.md`](agents/fixer.md) |
| **Best at** | Focused execution, bounded code changes, tests, follow-through after planning |
| **When to use** | Requirements are clear and the work is implementation-heavy |

### Available agents in-session

```text
/pantheon-agents
```

The command now acts as a lightweight specialist guide: it shows what each Pantheon specialist is best for, when not to use it, example task shapes, and the active source/model summary when available.

Bundled agents:

- `explorer`
- `librarian`
- `oracle`
- `designer`
- `fixer`
- `council`
- internal: `councillor`, `council-master`

---

## 📚 Documentation

### 🚀 Getting started

| Doc | Contents |
|-----|----------|
| [Installation Guide](docs/installation.md) | npm-based `pi install`, installer CLI, bootstrap flow, verification, troubleshooting |
| [Provider Configurations](docs/provider-configurations.md) | Pi model strings, mixed-provider presets, per-agent overrides, council diversity |
| [Quick Reference](docs/quick-reference.md) | Docs index and suggested reading order |

### ✨ Features

| Feature | Doc | What it covers |
|---------|-----|----------------|
| **Council** | [council.md](docs/council.md) | Multi-model consensus, presets, timeouts, and when to use `pantheon_council` |
| **Multiplexer Integration** | [multiplexer-integration.md](docs/multiplexer-integration.md) | Tmux-backed background panes, layout, attach/reuse, troubleshooting |
| **Cartography Skill** | [cartography.md](docs/cartography.md) | Hierarchical codemap generation and incremental repo mapping |
| **Interview / Spec Workflow** | [interview.md](docs/interview.md) | Upstream interview difference and the pi-native spec workflow replacement |

### ⚙️ Config & reference

| Doc | Contents |
|-----|----------|
| [Configuration](docs/configuration.md) | Config files, merge order, presets, overrides, schema usage |
| [Skills](docs/skills.md) | Bundled cartography skill, policy controls, setup hints |
| [MCPs / Adapters](docs/mcps.md) | Pi-native adapter system that fills the role upstream MCP docs cover |
| [Tools](docs/tools.md) | Background tasks, LSP, AST-grep, formatting, patch rescue, observability |
| [Author-style Preset](docs/authors-preset.md) | A practical mixed-provider preset for day-to-day Pantheon usage |
| [Repository Codemap](codemap.md) | Top-level architecture map for future contributors and agents |

---

## ✨ What this port includes

This pi package ports the most valuable `oh-my-opencode-slim` ideas into pi's native extension model:

- orchestrator-style top-level prompt injection
- specialist delegation via `pantheon_delegate`
- multi-model consensus via `pantheon_council`
- background specialist tasks with status, wait, result, retry, cancel, and attach flows
- tmux-backed multiplexer support for live background logs
- structured research through adapters and docs-aware fetch/search helpers, including smart `pantheon_webfetch`
- cartography / codemap workflows via a bundled `cartography` skill
- workflow-state persistence, auto-continue, and resume helpers
- richer code intelligence: LSP navigation, rename, organize-imports, format, patch, AST-grep
- debug traces, runtime inspection, hook tracing, and usage statistics
- prompt templates and review helpers: `/implement`, `/scout-and-plan`, `/implement-and-review`, `/ask-council`, `/review`

## 📦 Package / release setup

This repository is structured as a publishable pi package.

Included:

- `package.json` with the `pi` manifest
- `agents/`, `prompts/`, `skills/`, `extensions/`, and `bin/`
- `oh-my-opencode-pi.schema.json`
- publish-ready `files` entries including `docs/` and `codemap.md`
- package scripts:
  - `npm run typecheck`
  - `npm run pack:dry`
  - `npm run eval:orchestration`

Recommended validation cadence:

- fast PR-safe orchestration check:
  - `npm test -- tests/orchestration-evals.test.ts tests/orchestration-approval.test.ts tests/orchestration.test.ts tests/ui-rendering-approval.test.ts`
- fuller release / milestone validation:
  - `npm test`
  - `npm run typecheck`
  - `npm run eval:orchestration`
  - `npm run pack:dry`

To publish:

```bash
npm publish
```

## 🔎 Pi port notes

This package adapts Pantheon workflows to pi rather than cloning OpenCode behavior byte-for-byte.

Some upstream behavior remains runtime-bound, especially:

- OpenCode agent registry integration
- exact OpenCode hook/interception semantics
- exact `apply_patch` rescue semantics
- exact detached-session lifecycle behavior

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

Both JSON and JSONC are supported.

Minimal example:

```jsonc
{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["research", "durable"],
  "agents": {
    "oracle": { "model": "anthropic/claude-sonnet-4-5", "variant": "high" },
    "explorer": {
      "model": "openai/gpt-5.4-mini",
      "allowSkills": ["cartography"],
      "allowedAdapters": ["local-docs", "github-code-search", "web-search"]
    },
    "librarian": {
      "model": "openai/gpt-5.4-mini",
      "allowedAdapters": ["local-docs", "docs-context7", "npm-registry", "web-search"]
    }
  },
  "council": {
    "defaultPreset": "review-board"
  },
  "multiplexer": {
    "tmux": true,
    "layout": "main-vertical"
  }
}
```

For the full option map, presets, council config, adapter policy, and schema guidance, see [`docs/configuration.md`](docs/configuration.md).

## ⚡ Command center at a glance

| Command | Purpose |
|--------|---------|
| `/pantheon` | Open the command center |
| `/pantheon-agents` | List bundled/user/project Pantheon agents |
| `/pantheon-council` | Launch a council run interactively |
| `/pantheon-config` | Show config sources, presets, and warnings |
| `/pantheon-skills` | Show effective skill guidance |
| `/pantheon-adapters` | List adapters and effective policy |
| `/pantheon-backgrounds` | Inspect recent background tasks |
| `/pantheon-stats` | Inspect usage and reliability statistics |
| `/pantheon-version` | Inspect installed package version and cached update state |
| `/pantheon-update-check` | Force a fresh package update check |

For the full command list, see [`docs/quick-reference.md`](docs/quick-reference.md) and [`docs/tools.md`](docs/tools.md).

## 🧰 Core tool surface

### Delegation and consensus

- `pantheon_delegate`
- `pantheon_council`

### Background execution

- `pantheon_background`
- `pantheon_background_status`
- `pantheon_background_wait`
- `pantheon_background_result`
- `pantheon_background_watch`
- `pantheon_background_retry`
- `pantheon_background_cancel`
- `pantheon_background_attach`

### Code intelligence

- `pantheon_lsp_*` navigation / rename / diagnostics tools
- `pantheon_format_document`
- `pantheon_apply_patch`
- `pantheon_ast_grep_search`
- `pantheon_ast_grep_replace`

### Research and repository mapping

- `pantheon_adapter_*`
- `pantheon_webfetch`, `pantheon_fetch*`, `pantheon_search`
- `pantheon_repo_map`
- `pantheon_code_map`

See [`docs/tools.md`](docs/tools.md) for the complete breakdown.

## ✨ Feature highlights

### Background tasks + tmux

Pantheon can queue detached specialist work, persist task specs/results, and optionally attach live tmux panes for progress visibility.

See:
- [`docs/multiplexer-integration.md`](docs/multiplexer-integration.md)
- [`docs/tools.md`](docs/tools.md)

### Auto-continue + workflow state

The port can persist unchecked todos, auto-continue multi-step work, and generate resume context from previous background activity.

### Repo cartography

The bundled `cartography` skill generates and maintains `codemap.md` documentation backed by `.pi/cartography.json`.

See:
- [`docs/cartography.md`](docs/cartography.md)
- [`codemap.md`](codemap.md)

### Adapters instead of MCP runtime semantics

The pi port uses a policy-aware adapter system for docs, package, release, web, and code research.

See:
- [`docs/mcps.md`](docs/mcps.md)
- [`docs/provider-configurations.md`](docs/provider-configurations.md)

### Debugging and observability

Pantheon writes foreground debug traces and lightweight usage stats so failed delegate/council/background runs can be inspected after the fact. Foreground delegate/council runs also surface a live subagent activity widget below the editor, and `/pantheon-subagents` lets you inspect per-agent details or jump straight to the full trace.

See:
- [`docs/tools.md`](docs/tools.md)
- [`docs/workflows.md`](docs/workflows.md)

## 📘 Where the detailed reference lives now

The README is intentionally the overview. Detailed reference moved to the docs set:

- installation / verification → [`docs/installation.md`](docs/installation.md)
- providers / model strategy → [`docs/provider-configurations.md`](docs/provider-configurations.md)
- full config reference → [`docs/configuration.md`](docs/configuration.md)
- council behavior → [`docs/council.md`](docs/council.md)
- adapters / MCP-equivalent surface → [`docs/mcps.md`](docs/mcps.md)
- tools / commands / background / LSP / patch behavior → [`docs/tools.md`](docs/tools.md)
- runtime and workflow behavior → [`docs/workflows.md`](docs/workflows.md)

## Notes

- Top-level sessions get the orchestrator prompt automatically.
- Subagent sessions do **not** get it; they only receive their specialist prompt.
- `pantheon_council` works without custom config, but config is how you get real model diversity.
- This port adapts Pantheon workflows to pi rather than cloning OpenCode behavior exactly.
