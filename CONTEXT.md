# Pantheon Pi Orchestration

This context describes the user-facing language for Pantheon-style orchestration features in the pi port.

## Language

**Agent View**:
The feature area and interactive surface for dispatching, monitoring, inspecting, and managing specialist runs.
_Avoid_: agents, subagent view, background dashboard

**Specialist**:
A reusable role definition with a prompt, model/tool policy, and intended task profile, defined canonically through Pantheon/pi specialist Markdown.
_Avoid_: agent, worker, bot

**Run**:
One managed execution of a specialist against a task, identified by a `runId` in Agent View APIs and executed as a real pi session when attachable.
_Avoid_: job, session, invocation

**Run Status**:
The lifecycle state of a run: `queued`, `starting`, `running`, `needs_input`, `idle`, `completed`, `failed`, `stopped`, or `stale`; `queued` means waiting for supervisor capacity, `needs_input` means explicitly blocked on user/supervisor input, and `idle` means waiting but not blocked.
_Avoid_: job state, task status

**Attempt**:
One model/session execution within a Run, used for automatic fallback and retry history.
_Avoid_: try, retry, fallback run

**Run Group**:
An orchestration unit that contains multiple related Runs, such as parallel specialists, chained specialists, or a council followed by synthesis.
_Avoid_: batch, swarm, team

**Background Run**:
A detached, persisted run that can continue outside the foreground conversation and be inspected later.
_Avoid_: background task, daemon job, detached agent

**Supervisor**:
A detached local process that owns Agent View run lifecycle, persistence, event streaming, and recovery; supervisors may be user-scoped or project-scoped.
_Avoid_: daemon, background runner, task worker

## Relationships

- **Agent View** manages zero or more **Runs**.
- **Runs** can be launched either from Agent View UI or through Agent View tools; both surfaces use the same supervisor control path.
- Agent View tools replace the legacy `pantheon_delegate`, `pantheon_council`, and `pantheon_background*` public orchestration tools rather than wrapping them.
- Single **Runs** and **Run Groups** are launched through separate Agent View tools.
- Mandatory Agent View tools cover launch, launch group, list, status, reply, stop, delete, result, diff, apply, project registration, and doctor checks; attach and cleanup are user commands rather than LLM tools.
- Legacy background/debug artifacts are not imported into Agent View; cleanup-only tooling and documentation are provided for old artifacts.
- Read-only/research **Runs** may be auto-dispatched by orchestration policy; write-capable **Runs** require confirmation unless trusted configuration opts out.
- Agent View applies separate project-scoped and user-scoped concurrency limits, including a separate project limit for write-capable **Runs**.
- **Specialist** precedence is session/launch-provided, then project `.pi/agents/*.md`, then user `~/.pi/agent/agents/*.md`, then bundled `agents/*.md`.
- Session/launch-provided **Specialists** can be supplied through a JSON flag for automation or created temporarily through Agent View UI.
- Temporary **Specialist** JSON uses the Pantheon-native schema (`systemPrompt`, `noTools`, `options`) rather than Claude-compatible `prompt` fields.
- A **Run** uses its **Specialist** model by default; launch-time model overrides may replace it, and model fallback remains configuration-driven.
- Attaching to a **Run** means full terminal takeover of that Run's interactive pi session through a Supervisor-owned PTY; Agent View detail panes may still exist for quick inspection and reply.
- If PTY-backed attach is unavailable at runtime, Agent View degrades to detail-pane attach with an explicit diagnostic.
- PTY attach is implemented behind a `TerminalBackend` abstraction, with `node-pty` as the first backend and tmux as a possible future backend.
- Supervisor control of a **Run** uses a dual channel: structured sidecar control where available, with PTY keystroke injection only as fallback.
- Structured sidecar control is provided by an internal Agent View control extension loaded into Run pi processes and connected back to the Supervisor using a random per-Run capability token and restrictive local permissions.
- Run pi processes load minimal Agent View control by default; full oh-my-opencode-pi extension loading is policy-based and guarded by depth limits.
- Agent View launch nesting defaults to depth 1, meaning a Run cannot launch further Runs unless explicitly configured otherwise.
- A **Run** defaults to its **Specialist** policy, but Agent View must explicitly surface and confirm write-capable or shell-mutating policies unless trusted configuration opts out.
- Write-capable project-scoped **Runs** use isolated git worktrees by default when a git root exists; users may explicitly opt out, and non-git projects should warn before writing in place.
- Worktree **Run** results are reviewed diff-first; applying or merging changes into the main project requires explicit confirmation.
- Applying worktree results supports patch application for uncommitted changes and branch/commit merge paths if commits exist, but write-capable **Runs** do not commit their own changes by default.
- Agent View does not create pull requests in v1.
- Agent View groups **Runs** by actionability/status by default and can toggle grouping by project or **Specialist**.
- Agent View supports both structured launch UI and shorthand dispatch; `@specialist` wins over `@project` on name conflicts and the resolved launch target is shown before launch.
- `/pantheon-agent-view` is the canonical Agent View command; `/agents` is a short alias.
- Write-capable shorthand launches require confirmation by default; trusted configuration may opt out.
- Agent View creates project worktrees in a sibling directory named `<project-name>.oh-my-opencode-pi-worktrees/<runId>/`.
- Worktree branches use descriptive names like `agent-view/<specialist>/<task-slug>-<shortRunId>`.
- Empty or unchanged worktrees may be cleaned automatically; changed worktrees remain until the **Run** is deleted or explicitly cleaned after apply.
- User-scoped **Runs** are read/research/coordinator work only; code edits happen through project-scoped **Runs**.
- A **Run** uses exactly one **Specialist** and may contain one or more **Attempts**.
- A **Run Group** contains two or more related **Runs**.
- Chained **Run Groups** store structured dependencies and may also support `{previous}` placeholder expansion for task text.
- A **Run** is `completed` only when the active **Attempt** reaches a normal assistant final response.
- A **Run Result** includes a reference to the final assistant message plus derived structured metadata such as summary, artifacts, changed files, diff path, and status.
- Changed files and diffs are detected with git diff when available, supplemented by tool-event tracking as fallback.
- Stopping a **Run** stops execution and preserves artifacts; deleting a **Run** removes registry/session/worktree artifacts after confirmation.
- Stale read-only **Runs** may auto-respawn; stale write-capable **Runs** require user confirmation before resuming.
- A **Run** persists its pi session file and a normalized Agent View event log.
- The pi session file is the transcript source of truth; the Agent View event log records lifecycle, status, UI, and recovery events rather than mirroring full transcript content.
- Agent View artifact records include session, event log, PTY transcript or stdout/stderr, diff, patch, worktree, summary, debug trace, and result JSON.
- PTY transcripts are sanitized, text-only, and size-capped by default; raw PTY recording is only enabled by debug configuration.
- Agent View keeps failed, stale, input-blocked, and write-capable **Runs** until explicit deletion; completed read-only **Runs** may be pruned by configurable age/count.
- Agent View row summaries are model-generated by a dedicated Agent View summary model configured separately from Run models.
- Row summaries update on status transitions and at a throttled cadence while a **Run** is running.
- A **Background Run** is a **Run** with persisted lifecycle state.
- A **Supervisor** owns the lifecycle of one or more **Runs**.
- A user-scoped **Supervisor** coordinates and routes across projects; project-scoped **Supervisors** execute and own project-local **Runs**.
- **Runs** launched from inside a project default to the project-scoped **Supervisor**; user-scoped **Runs** must be explicitly requested.
- A project is identified by the nearest git root, falling back to the current working directory when no git root exists.
- The user-scoped **Supervisor** discovers projects from known **Runs** and explicit project registration, not by broad filesystem scanning.
- Project registration stores canonical root path, project ID/hash, display name, and last-seen timestamp.
- Agent View configuration lives in the existing oh-my-opencode-pi configuration under an `agentView` section.
- Minimum Agent View config includes enablement, summary model, project/user concurrency limits, write-run concurrency limits, summary refresh interval, trusted auto-launch, read-only auto-respawn, write-run confirmation, and worktree enablement/location.
- Project-scoped **Runs** store execution artifacts in `.oh-my-opencode-pi-agent-view/` inside the project.
- User-scoped **Runs** and the cross-project index store artifacts in `~/.pi/agent/oh-my-opencode-pi/agent-view/`.

## Example dialogue

> **Dev:** "Should the **Agent View** show all specialists?"
> **Domain expert:** "Yes, but launching a **Run** is separate from browsing available **Specialists**. A **Background Run** should remain inspectable even after the foreground conversation ends."

## Flagged ambiguities

- "agent" was used to mean specialist definitions, spawned subagents, background work, Claude Agent View, and the main pi assistant. Resolved: use **Specialist**, **Run**, **Background Run**, and **Agent View** for distinct concepts.
