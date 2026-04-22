# Quick Reference

> This page is the docs index for `oh-my-opencode-pi`. It mirrors the upstream `oh-my-opencode-slim` structure, but the content is adapted for pi-native commands, tools, and config.

## 🚀 Getting Started

| Doc | Contents |
|-----|----------|
| [Installation Guide](installation.md) | `pi install`, installer CLI, bootstrap flow, verification, troubleshooting |
| [Provider Configurations](provider-configurations.md) | Pi model strings, mixed-provider presets, per-agent overrides, council diversity |

## ✨ Features

| Doc | Contents |
|-----|----------|
| [Council](council.md) | Multi-model consensus, presets, timeouts, when to use `pantheon_council` |
| [Multiplexer Integration](multiplexer-integration.md) | Tmux-backed background panes, layouts, attach/reuse behavior |
| [Cartography Skill](cartography.md) | Hierarchical codemap generation and incremental repo mapping |
| [Pantheon Workflows](workflows.md) | Delegate vs council vs background, inspection paths, recovery workflows, and the `/review` helper |
| [Interview / Spec Workflow](interview.md) | Upstream interview difference and the pi-native spec workflow replacement |

## ⚙️ Config & Reference

| Doc | Contents |
|-----|----------|
| [Skills](skills.md) | Bundled karpathy-guidelines + cartography skills, policy controls, setup hints |
| [MCPs / Adapters](mcps.md) | Pi-native adapter system that fills the role upstream MCP docs cover |
| [Tools](tools.md) | Background tasks, doctor/health checks, LSP, AST-grep, formatting, patch rescue, observability |
| [Configuration](configuration.md) | Config file locations, merge order, schema/diagnostics, presets, overrides, full option map |
| [Orchestration Evals](evals.md) | Fast PR-safe suite, full release suite, deterministic scenarios, approval fixtures, benchmark harness, and eval reporting |

## 💡 Presets

| Doc | Contents |
|-----|----------|
| [Author-style Preset](authors-preset.md) | A practical mixed-provider preset for daily Pantheon usage in pi |

## Command quick reference

### Core commands

These are the commands most users should start with:

- `/pantheon` — open the simplified command center for start/resume/tasks/troubleshooting flows
- `/pantheon-council` — ask for a high-confidence multi-model decision
- `/review` — launch the structured code-review helper
- `/pantheon-task-actions <taskId>` — one menu for task inspection, retry, cancel, attach, and logs
- `/pantheon-resume` — rebuild context from persisted todos and recent background tasks
- `/pantheon-spec-studio` — create a structured spec template in the editor
- `/pantheon-doctor` — run setup and runtime health checks when something feels off

### Advanced / expert commands

Keep these for lower-frequency setup, inspection, and maintainer workflows:

- `/pantheon-config` — inspect merged config and diagnostics
- `/pantheon-overview` — combined workflow + background status
- `/pantheon-as <agent>` — route the next task directly to a specialist
- `/pantheon-hooks` — inspect hook ordering and restored runtime middleware state
- `/pantheon-debug [traceId]` — inspect a full debug trace
- `/pantheon-subagents` — inspect live/recent subagent activity and jump to trace details
- `/pantheon-adapters` — inspect the current adapter policy report
- `/pantheon-adapter-health` — inspect adapter auth/readiness
- `/pantheon-bootstrap` — scaffold project-local Pantheon files

## Suggested reading order

1. [installation.md](installation.md)
2. [provider-configurations.md](provider-configurations.md)
3. [quick-reference.md](quick-reference.md)
4. [configuration.md](configuration.md)
5. [workflows.md](workflows.md)
6. whichever feature guide matches your task
