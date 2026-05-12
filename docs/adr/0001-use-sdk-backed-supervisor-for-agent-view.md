# Use an SDK-backed supervisor for Agent View

We will build Agent View around a detached supervisor that owns real pi sessions, rather than only wrapping the existing Pantheon delegate/background task machinery. Attachable runs execute as real `pi` processes in supervisor-owned PTYs, while the Pi SDK is used as a supporting/control layer for inspection, summaries, registry integration, and noninteractive utilities. This is harder than a manager-only UI, but it gives Agent View true resumable runs, full terminal attach, and a path toward Claude Code-style background session behavior instead of permanently coupling the feature to one-shot spawned `pi -p` runs.

**Considered Options**

- Reuse existing Pantheon background task artifacts and add a manager UI.
- Build a new supervisor around real `pi` PTY processes, with Pi SDK support for control and inspection.

**Consequences**

- Existing Pantheon background and subagent management internals should be rewritten around SDK-backed Agent View runs rather than kept as a parallel execution model.
- The first implementation must support both user-scoped and project-scoped supervisors: the user-scoped supervisor coordinates and routes across projects, while project-scoped supervisors execute and own project-local runs. Project-scoped run artifacts live in `.oh-my-opencode-pi-agent-view/` inside the project; user-scoped runs and the cross-project index live in `~/.pi/agent/oh-my-opencode-pi/agent-view/`. Agent View talks to supervisors over Unix-domain-socket JSON-RPC, while durable state remains file-backed for recovery and inspection. It must solve lifecycle, persistence, event streaming, and recovery before polishing the UI.
- Public tools and commands should be renamed around **Agent View** rather than preserving `pantheon_background*` compatibility aliases; this is an intentional breaking change to remove the old execution model from the user-facing API.
- Agent View should land as a big bang rewrite rather than phased vertical slices behind a feature flag, despite the increased integration risk.
- Big bang means one massive implementation issue/PR rather than multiple internal PRs hidden behind one public release; this is intentionally accepted despite review and integration risk.
- The big bang acceptance bar includes full terminal attach for a Run's interactive pi session, not only an Agent View detail pane. Full terminal attach is PTY-backed: the supervisor owns a pseudo-terminal per attachable run, and Agent View connects the user's terminal to it.
- Completion requires unit tests for registry/config/schema/worktree behavior, JSON-RPC supervisor integration tests, process-level Run lifecycle smoke tests, and PTY attach tests through a fake/backend abstraction rather than brittle real-terminal goldens.
- Documentation completion requires a dedicated Agent View guide plus README, tools, workflows, configuration/schema, codemap, and breaking-migration updates.
- Implementation should prefer package-level workarounds first; any pi core primitives found necessary for robust attach/control should be explicitly tracked as core gaps rather than silently weakening Agent View semantics.
