# agent-view-decisions

Date: 2026-05-12
Source: MemPalace
Wing: omo-slim-pi
Room: agent-view-decisions
Shared by: pi-coding-orchestrator

## Summary

Agent View planning decisions resolved on 2026-05-12:

## Details

Agent View planning decisions resolved on 2026-05-12:

- Agent View is the feature area and interactive surface for dispatching, monitoring, inspecting, and managing specialist runs.
- Specialist = reusable role definition with prompt, model/tool policy, and intended task profile.
- Run = one managed execution of a specialist against a task, identified by runId in Agent View APIs.
- Supervisor = detached local process that owns Agent View run lifecycle, persistence, event streaming, and recovery.
- Agent View will be built around a detached SDK-backed session supervisor, not only existing Pantheon delegate/background task machinery.
- Existing Pantheon background and subagent management internals should be rewritten around SDK-backed Agent View runs.
- Public tools and commands should be renamed around Agent View; no pantheon_background compatibility aliases are required.
- Agent View is the API namespace; Run remains the managed entity noun.
- The implementation must support both user-scoped and project-scoped supervisors.
- User-scoped Supervisor coordinates/routes across projects; project-scoped Supervisors execute and own project-local Runs.
- Runs launched from inside a project default to project Supervisor; user-scoped Runs must be explicitly requested.
- Project identity is nearest git root, falling back to cwd.

Sanitized team docs already updated in CONTEXT.md and docs/adr/0001-use-sdk-backed-supervisor-for-agent-view.md.

## Why this matters for the team

- Records decision context teammates should not have to rediscover.
- Helps future changes preserve the intended trade-offs.

## Follow-ups

- [ ] Existing Pantheon background and subagent management internals should be rewritten around SDK-backed Agent View runs.
- [ ] Public tools and commands should be renamed around Agent View; no pantheon_background compatibility aliases are required.

---

## Additional note — 14:00

Date: 2026-05-12
Source: MemPalace
Wing: omo-slim-pi
Room: agent-view-decisions
Shared by: pi-coding-orchestrator

### Summary

Agent View planning decisions continued on 2026-05-12:

### Details

Agent View planning decisions continued on 2026-05-12:

- Hybrid storage is accepted.
- Project-scoped run artifacts live in `.oh-my-opencode-pi-agent-view/`.
- User-scoped runs and the cross-project index live in `~/.pi/agent/oh-my-opencode-pi/agent-view/`.
- Agent View talks to supervisors over Unix-domain-socket JSON-RPC; durable state remains file-backed for recovery and inspection.
- Canonical Run Status values: `queued`, `starting`, `running`, `needs_input`, `idle`, `completed`, `failed`, `stopped`, `stale`.
- v1 attach means an interactive Agent View detail pane with transcript, reply, steer, and cancel controls; full terminal takeover is a future possibility.
- Runs default to Specialist policy; write-capable or shell-mutating policies must be surfaced and confirmed unless trusted config opts out.
- Write-capable project-scoped Runs use isolated git worktrees by default when a git root exists.
- User-scoped Runs are read/research/coordinator work only; code edits happen through project-scoped Runs.
- Pantheon/pi Specialist Markdown is canonical.
- Specialist precedence is session/launch-provided, project `.pi/agents/*.md`, user `~/.pi/agent/agents/*.md`, bundled `agents/*.md`.
- Temporary Specialist JSON uses Pantheon-native schema (`systemPrompt`, `noTools`, `options`).
- Runs use Specialist model by default; launch-time overrides may replace it; fallback remains configuration-driven.
- Runs may contain multiple Attempts for automatic fallback and retry history.
- A Run is completed only when the active Attempt reaches a normal assistant final response.

Sanitized team docs are maintained in CONTEXT.md and docs/adr/0001-use-sdk-backed-supervisor-for-agent-view.md.

### Why this matters for the team

- Records decision context teammates should not have to rediscover.
- Helps future changes preserve the intended trade-offs.

### Follow-ups

- [ ] Runs default to Specialist policy; write-capable or shell-mutating policies must be surfaced and confirmed unless trusted config opts out.
- [ ] Write-capable project-scoped Runs use isolated git worktrees by default when a git root exists.

---

## Additional note — 14:11

Date: 2026-05-12
Source: MemPalace
Wing: omo-slim-pi
Room: agent-view-decisions
Shared by: pi-coding-orchestrator

### Summary

Agent View planning decisions continued on 2026-05-12:

### Details

Agent View planning decisions continued on 2026-05-12:

- `needs_input` means explicitly blocked on user/supervisor input; `idle` means waiting but not blocked.
- Run input supports default reply plus advanced `steer` and `follow_up` modes.
- Runs persist both Pi SDK session file and normalized Agent View event log.
- Pi SDK session file is transcript source of truth.
- Agent View event log records lifecycle, status, UI, and recovery events rather than mirroring full transcript content.
- Row summaries are model-generated by a dedicated Agent View summary model configured separately from Run models.
- Row summaries update on status transitions and at a throttled cadence while a Run is running.
- Runs can be launched from Agent View UI or through Agent View tools; both are first-class and use the same supervisor control path.
- Read-only/research Runs may be auto-dispatched by orchestration policy; write-capable Runs require confirmation unless trusted configuration opts out.
- Agent View applies separate project-scoped and user-scoped concurrency limits, including a separate project limit for write-capable Runs.
- When concurrency limits are reached, Runs queue automatically.
- Stopping a Run stops execution and preserves artifacts; deleting a Run removes registry/session/worktree artifacts after confirmation.
- Stale read-only Runs may auto-respawn; stale write-capable Runs require user confirmation before resuming.
- Worktree Run results are reviewed diff-first; applying or merging changes into the main project requires explicit confirmation.

Sanitized team docs are maintained in CONTEXT.md and docs/adr/0001-use-sdk-backed-supervisor-for-agent-view.md.

### Why this matters for the team

- Records decision context teammates should not have to rediscover.
- Helps future changes preserve the intended trade-offs.

### Follow-ups

- [ ] Row summaries update on status transitions and at a throttled cadence while a Run is running.
- [ ] Read-only/research Runs may be auto-dispatched by orchestration policy; write-capable Runs require confirmation unless trusted configuration opts out.
- [ ] Agent View applies separate project-scoped and user-scoped concurrency limits, including a separate project limit for write-capable Runs.
- [ ] Stale read-only Runs may auto-respawn; stale write-capable Runs require user confirmation before resuming.

---

## Additional note — 14:22

Date: 2026-05-12
Source: MemPalace
Wing: omo-slim-pi
Room: agent-view-decisions
Shared by: pi-coding-orchestrator

### Summary

Agent View planning decisions continued on 2026-05-12:

### Details

Agent View planning decisions continued on 2026-05-12:

- Agent View creates project worktrees in sibling directory `<project-name>.oh-my-opencode-pi-worktrees/<runId>/`.
- Worktree branches use descriptive names like `agent-view/<specialist>/<task-slug>-<shortRunId>`.
- Empty or unchanged worktrees may be cleaned automatically; changed worktrees remain until the Run is deleted or explicitly cleaned after apply.
- Applying worktree results supports patch application for uncommitted changes and branch/commit merge paths if commits exist.
- Write-capable Runs do not commit their own changes by default.
- Agent View does not create pull requests in v1.
- Agent View groups Runs by actionability/status by default and can toggle grouping by project or Specialist.
- Agent View supports structured launch UI and shorthand dispatch; `@specialist` wins over `@project` on conflicts.
- Write-capable shorthand launches require confirmation by default; trusted config may opt out.
- User Supervisor discovers projects from known Runs and explicit registration, not filesystem scanning.
- Project registration stores canonical root path, project ID/hash, display name, and last-seen timestamp.
- Agent View config lives under existing oh-my-opencode-pi config `agentView` section.
- Minimum config includes enablement, summary model, concurrency limits, summary refresh, trusted auto-launch, read-only auto-respawn, write-run confirmation, and worktree enablement/location.
- Implementation should be a big bang rewrite rather than phased vertical slices.
- Big bang acceptance bar includes core parity plus full terminal attach.

Sanitized team docs are maintained in CONTEXT.md and docs/adr/0001-use-sdk-backed-supervisor-for-agent-view.md.

### Why this matters for the team

- Records decision context teammates should not have to rediscover.
- Helps future changes preserve the intended trade-offs.

### Follow-ups

- [ ] Write-capable Runs do not commit their own changes by default.
- [ ] Agent View does not create pull requests in v1.
- [ ] Write-capable shorthand launches require confirmation by default; trusted config may opt out.
- [ ] Minimum config includes enablement, summary model, concurrency limits, summary refresh, trusted auto-launch, read-only auto-respawn, write-run confirmation, and worktree enablement/location.
- [ ] Implementation should be a big bang rewrite rather than phased vertical slices.

---

## Additional note — 14:32

Date: 2026-05-12
Source: MemPalace
Wing: omo-slim-pi
Room: agent-view-decisions
Shared by: pi-coding-orchestrator

### Summary

Agent View planning decisions continued on 2026-05-12:

### Details

Agent View planning decisions continued on 2026-05-12:

- If PTY-backed attach is unavailable, Agent View degrades to detail-pane attach with explicit diagnostic.
- PTY attach is implemented behind a `TerminalBackend` abstraction, with `node-pty` first and tmux as possible future backend.
- Runs execute as real `pi` processes in Supervisor-owned PTYs; the Pi SDK is a support/control/inspection layer, not the execution source of truth.
- Supervisor control uses dual channel: structured sidecar control where available, PTY keystroke injection as fallback.
- Structured sidecar control is provided by an internal Agent View control extension loaded into Run pi processes and connected back to Supervisor.
- Run pi processes load minimal Agent View control by default; full oh-my-opencode-pi extension loading is policy-based and guarded by depth limits.
- Agent View launch nesting defaults to depth 1.
- Sidecar control authenticates with random per-Run capability token plus restrictive local permissions.
- Agent View public tools replace legacy `pantheon_delegate`, `pantheon_council`, and `pantheon_background*` orchestration tools.
- Council is represented as a Run Group.
- Parallel and chain delegation are Run Groups too.
- Chained Run Groups store structured dependencies and may support `{previous}` placeholder expansion.
- Run Result includes final assistant message reference plus derived structured metadata such as summary, artifacts, changed files, diff path, and status.

Sanitized team docs are maintained in CONTEXT.md and docs/adr/0001-use-sdk-backed-supervisor-for-agent-view.md.

### Why this matters for the team

- Records decision context teammates should not have to rediscover.
- Helps future changes preserve the intended trade-offs.

### Follow-ups

_None captured._
