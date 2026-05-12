# Agent View Big Bang Rewrite PRD

## Problem Statement

Users need a Claude Code-style way to dispatch, monitor, inspect, attach to, and manage multiple Pantheon specialist executions without relying on the current one-shot delegate/background machinery. The existing foreground delegation, council, and background task surfaces are fragmented: they expose separate tools and commands, persist state differently, and cannot provide a single Agent View with true resumable Runs, full terminal attach, user/project supervision, policy-based safety, and worktree-isolated write execution.

## Solution

Build Agent View as the new public orchestration surface for Pantheon in pi. Agent View will replace the legacy delegate, council, and background public APIs with a Supervisor-backed model where Specialists launch Runs or Run Groups. Runs execute as real pi sessions in Supervisor-owned PTYs when attachable, persist their pi session file plus normalized lifecycle events, and can be launched from both Agent View UI and LLM tools. A user-scoped Supervisor coordinates across projects, while project-scoped Supervisors execute project-local Runs, enforce worktree isolation for write-capable project Runs, and persist project artifacts locally.

The rewrite is intentionally a single big-bang implementation issue/PR, not a phased migration. It includes renamed Agent View tools/commands, a new Supervisor control plane, Run lifecycle management, full PTY terminal attach with graceful degradation, Run Group orchestration for council/parallel/chain workflows, worktree diff/apply flows, model-generated row summaries, tests, docs, schema updates, and cleanup-only legacy artifact handling.

## User Stories

1. As a pi user, I want to open Agent View, so that I can see all managed Pantheon Runs from one surface.
2. As a pi user, I want `/pantheon-agent-view` as the canonical command, so that I can reliably open the feature by name.
3. As a pi user, I want `/agents` as a short alias, so that opening Agent View feels fast and familiar.
4. As a pi user, I want Agent View to group Runs by actionability/status by default, so that blocked and active work is easy to find.
5. As a pi user, I want Agent View to toggle grouping by project, so that I can understand cross-project work.
6. As a pi user, I want Agent View to toggle grouping by Specialist, so that I can compare role-specific work.
7. As a pi user, I want to launch a Run from Agent View UI, so that I can delegate a task without typing tool JSON.
8. As an orchestrating assistant, I want to launch a Run through an Agent View tool, so that I can delegate work programmatically.
9. As an orchestrating assistant, I want to launch a Run Group through a separate Agent View tool, so that multi-Run orchestration is explicit.
10. As a pi user, I want shorthand dispatch such as `@specialist task`, so that power-user launch flows are quick.
11. As a pi user, I want `@specialist` to win over `@project` on name conflicts, so that dispatch ambiguity is deterministic.
12. As a pi user, I want Agent View to show the resolved launch target before launch, so that shorthand mistakes are visible.
13. As a pi user, I want write-capable shorthand launches to require confirmation by default, so that accidental edits do not start silently.
14. As a pi user, I want trusted configuration to skip some confirmations, so that trusted workflows remain fast.
15. As a pi user, I want read-only/research Runs to be auto-dispatchable by policy, so that safe exploration can happen autonomously.
16. As a pi user, I want write-capable Runs to require explicit permission unless trusted config opts out, so that unattended edits are controlled.
17. As a pi user, I want a Run to have a stable `runId`, so that tools, UI, and logs can refer to the same execution.
18. As a pi user, I want Run Status values to distinguish `queued`, `starting`, `running`, `needs_input`, `idle`, `completed`, `failed`, `stopped`, and `stale`, so that I can understand what each Run needs.
19. As a pi user, I want `needs_input` to mean explicitly blocked, so that Agent View does not over-alert me for ordinary idle Runs.
20. As a pi user, I want `idle` to mean waiting but not blocked, so that I can resume or reply without treating it as urgent.
21. As a pi user, I want Runs to queue automatically when concurrency is full, so that large batches do not fail just because capacity is temporarily unavailable.
22. As a pi user, I want separate project and user concurrency limits, so that global coordination does not starve project work.
23. As a pi user, I want a separate write-capable project concurrency limit, so that multiple editing Runs do not create unmanageable merge pressure.
24. As a pi user, I want a user-scoped Supervisor, so that Agent View can coordinate Runs across projects.
25. As a pi user, I want project-scoped Supervisors, so that project-local Runs execute with the right configuration, filesystem boundaries, and worktree policy.
26. As a pi user, I want Runs launched from inside a project to default to the project Supervisor, so that coding work stays project-local.
27. As a pi user, I want user-scoped Runs to require explicit selection, so that cross-project work is intentional.
28. As a pi user, I want projects identified by nearest git root with cwd fallback, so that project boundaries match normal coding workflows.
29. As a pi user, I want explicit project registration, so that global Agent View can target projects without broad filesystem scanning.
30. As a pi user, I want known Runs to register their projects automatically, so that the global index stays useful over time.
31. As a pi user, I want project registration to store root path, project ID/hash, display name, and last-seen timestamp, so that the global view is stable and readable.
32. As a pi user, I want project-scoped Run artifacts in the project, so that project-local execution is inspectable and cleanup is obvious.
33. As a pi user, I want user-scoped Runs and the cross-project index under my pi agent directory, so that global state is not scattered through arbitrary repos.
34. As a pi user, I want Agent View to talk to Supervisors over Unix-domain-socket JSON-RPC, so that live control is structured and local.
35. As a pi user, I want durable file-backed state, so that Agent View can recover after process crashes or terminal exits.
36. As a pi user, I want full terminal attach to a Run, so that I can take over an interactive pi session when needed.
37. As a pi user, I want full terminal attach to use a Supervisor-owned PTY, so that attaching is an honest terminal takeover rather than a transcript simulation.
38. As a pi user, I want PTY failure to degrade to a detail-pane attach with a diagnostic, so that Runs remain inspectable on unsupported systems.
39. As a maintainer, I want PTY support behind a TerminalBackend abstraction, so that node-pty, fake test backends, and future tmux backends can share one interface.
40. As a pi user, I want attachable Runs to execute as real pi processes, so that their behavior matches normal interactive pi sessions.
41. As a maintainer, I want the Pi SDK used as a supporting/control layer rather than the execution source of truth, so that full terminal attach remains practical.
42. As a pi user, I want structured sidecar control where possible, so that Agent View can reply, steer, stop, and read status without fragile terminal input.
43. As a pi user, I want PTY keystroke injection as fallback only, so that control remains robust when the sidecar is available.
44. As a maintainer, I want an internal Agent View control extension loaded into Run pi processes, so that Runs can report lifecycle events and accept structured control.
45. As a maintainer, I want sidecar control authenticated by a per-Run capability token, so that only the owning Supervisor can control that Run.
46. As a pi user, I want Run processes to load minimal Agent View control by default, so that nested orchestration and tool exposure are limited.
47. As a pi user, I want full extension loading to be policy-based, so that orchestrator-like Specialists can be enabled intentionally.
48. As a maintainer, I want launch nesting to default to depth 1, so that Runs cannot recursively spawn more Runs by default.
49. As a pi user, I want Specialists to remain canonical Pantheon/pi Markdown definitions, so that existing specialist authoring conventions remain the source of truth.
50. As a pi user, I want Specialist precedence to be session/launch, project, user, then bundled, so that explicit and local definitions win.
51. As an automation user, I want temporary Specialists from a JSON flag, so that scripts can define one-off Specialist behavior.
52. As a pi user, I want temporary Specialists from Agent View UI, so that I can create one-off roles interactively.
53. As a maintainer, I want temporary Specialist JSON to use the Pantheon-native schema, so that internal policy fields remain consistent.
54. As a pi user, I want a Run to use its Specialist model by default, so that role-specific model choices are respected.
55. As a pi user, I want launch-time model overrides, so that I can choose a different model for a specific Run.
56. As a pi user, I want model fallback to remain configuration-driven, so that Pantheon reliability behavior is preserved.
57. As a pi user, I want a Run to contain multiple Attempts, so that automatic fallback and retry history are visible.
58. As a pi user, I want a Run to complete only on a normal assistant final response, so that blocked or failed states are not mislabeled as successful.
59. As a pi user, I want default reply plus advanced steer/follow-up modes, so that common replies are simple and advanced control remains possible.
60. As a pi user, I want Run Results to include final message reference and structured metadata, so that UI, tools, and chain dependencies can consume results consistently.
61. As a pi user, I want changed files and diffs derived from git diff when possible, so that worktree results are reliable.
62. As a pi user, I want tool-event tracking as a fallback for changed file detection, so that non-git and tool-mediated changes can still be surfaced.
63. As a pi user, I want write-capable project Runs to use isolated git worktrees by default, so that parallel editing does not corrupt my main checkout.
64. As a pi user, I want to opt out of worktree isolation explicitly, so that exceptional same-checkout workflows remain possible.
65. As a pi user, I want non-git projects to warn before writing in place, so that reduced isolation is visible.
66. As a pi user, I want user-scoped Runs to be read/research/coordinator only, so that code edits happen through project boundaries.
67. As a pi user, I want worktrees created in a sibling directory, so that generated checkouts are discoverable without nesting inside the repo.
68. As a pi user, I want worktree branches named with Specialist, task slug, and Run ID, so that branches are understandable.
69. As a pi user, I want empty or unchanged worktrees auto-cleaned, so that no-op Runs do not leave clutter.
70. As a pi user, I want changed worktrees retained until delete or explicit cleanup, so that I do not lose edits before review.
71. As a pi user, I want worktree results reviewed diff-first, so that I can understand changes before applying them.
72. As a pi user, I want explicit apply/merge confirmation, so that Run changes never land silently in my main project.
73. As a pi user, I want patch apply for uncommitted changes, so that normal Run output can be applied without requiring commits.
74. As a pi user, I want branch/commit merge paths when commits exist, so that exceptional committed output can still be consumed.
75. As a pi user, I do not want Runs to commit by default, so that review stays diff-first and local.
76. As a pi user, I do not want Agent View to create pull requests in v1, so that the first implementation stays local and provider-neutral.
77. As a pi user, I want stopping a Run to preserve artifacts, so that I can inspect or retry later.
78. As a pi user, I want deleting a Run to remove registry/session/worktree artifacts after confirmation, so that cleanup is explicit.
79. As a pi user, I want stale read-only Runs to auto-respawn when policy allows, so that safe work can recover without manual intervention.
80. As a pi user, I want stale write-capable Runs to require confirmation before resuming, so that edits do not continue unexpectedly after crashes.
81. As a pi user, I want a pi session file persisted for each Run, so that the transcript source of truth is durable.
82. As a pi user, I want a normalized Agent View event log, so that lifecycle/status/UI/recovery events are easy to render and debug.
83. As a pi user, I want the event log not to mirror the full transcript, so that storage and privacy risk are limited.
84. As a pi user, I want artifact records for session, event log, PTY transcript, diff, patch, worktree, summary, debug trace, and result JSON, so that Run outputs are discoverable.
85. As a pi user, I want PTY transcripts sanitized and size-capped by default, so that terminal attach debugging does not leak or bloat excessively.
86. As a maintainer, I want raw PTY recording only under debug config, so that deeper diagnosis is opt-in.
87. As a pi user, I want failed, stale, input-blocked, and write-capable Runs retained until explicit deletion, so that important work is not pruned prematurely.
88. As a pi user, I want completed read-only Runs pruned by configurable age/count, so that disk usage is controlled.
89. As a pi user, I want model-generated row summaries, so that Agent View communicates each Run's current state clearly.
90. As a pi user, I want row summaries generated by a dedicated summary model, so that summary cost is controlled separately from Run cost.
91. As a pi user, I want row summaries updated on status transitions and throttled while running, so that the UI stays fresh without excessive model calls.
92. As a pi user, I want Council represented as a Run Group, so that multi-perspective workflows remain first-class.
93. As a pi user, I want parallel delegation represented as a Run Group, so that related parallel Runs are grouped.
94. As a pi user, I want chain delegation represented as a Run Group, so that dependent specialist steps are visible together.
95. As a pi user, I want chained Run Groups to store structured dependencies, so that prior outputs are passed reliably.
96. As a pi user, I want `{previous}` placeholder compatibility in chain tasks, so that existing chain patterns remain expressible.
97. As a pi user, I want new Agent View tools to replace `pantheon_delegate`, `pantheon_council`, and `pantheon_background*`, so that the public API matches the new model.
98. As a pi user, I want cleanup-only legacy handling, so that old artifacts can be removed without carrying old execution semantics forward.
99. As a pi user, I want `agentView` configuration in existing package config, so that Agent View is configured alongside the rest of Pantheon.
100. As a maintainer, I want the schema updated for Agent View config, so that users get validation and completion.
101. As a pi user, I want an Agent View doctor command, so that supervisor, socket, PTY, config, and storage health can be diagnosed.
102. As a pi user, I want attach and cleanup to be commands rather than LLM tools, so that terminal takeover and destructive cleanup remain user-driven.
103. As an orchestrating assistant, I want tools for launch, launch group, list, status, reply, stop, delete, result, diff, apply, project registration, and doctor checks, so that I can operate Agent View safely through structured calls.
104. As a maintainer, I want package-level workarounds attempted before requiring pi core changes, so that implementation can proceed in this package.
105. As a maintainer, I want pi core gaps tracked explicitly if discovered, so that semantics are not silently weakened.
106. As a maintainer, I want one big implementation issue/PR, so that the public rewrite lands as a single deliberate migration.
107. As a maintainer, I want tests covering registry, config, schema, worktree behavior, JSON-RPC supervisor behavior, process lifecycle, and PTY attach via fake backend, so that the big bang rewrite is still verifiable.
108. As a documentation reader, I want a dedicated Agent View guide and migration notes, so that I can understand the new model and removed APIs.

## Implementation Decisions

- Build a new Agent View execution model rather than wrapping the existing delegate/background implementation.
- Treat the rewrite as a public breaking change: legacy orchestration tools and commands are replaced by Agent View tools and commands rather than preserved as compatibility aliases.
- Use the domain language in `CONTEXT.md`: Agent View, Specialist, Run, Run Status, Attempt, Run Group, Background Run, and Supervisor.
- Agent View is the public namespace; Run is the managed entity. Tools return and accept `runId` for single Runs and a group identifier for Run Groups.
- Add a user-scoped Supervisor that coordinates and routes across projects.
- Add project-scoped Supervisors that execute project-local Runs and own project-local artifacts.
- Use nearest git root as project identity, falling back to cwd outside git repos.
- Store project Run artifacts under the project-local Agent View artifact directory.
- Store user-scoped Runs and the cross-project index under the package-owned Agent View directory in the user's pi agent directory.
- Use Unix-domain-socket JSON-RPC for live Supervisor control.
- Keep durable state file-backed for recovery and inspection.
- Implement Run execution as real `pi` processes in Supervisor-owned PTYs when attachable.
- Use the Pi SDK as a support/control/inspection layer rather than the execution source of truth.
- Implement PTY attach behind a TerminalBackend deep module. The interface should support spawn, attach, detach, resize, write input, read output, stop, and health checks without exposing backend-specific details.
- Use `node-pty` as the first TerminalBackend implementation.
- Keep tmux as a possible future TerminalBackend rather than the first implementation.
- Degrade to detail-pane attach with an explicit diagnostic if PTY attach is unavailable.
- Implement a Run control sidecar deep module through an internal Agent View control extension loaded into Run pi processes.
- Connect the sidecar to the Supervisor through environment-provided socket path and per-Run capability token.
- Use restrictive local permissions for sockets and artifact files.
- Use structured sidecar control for reply, steer, follow-up, stop, status, lifecycle events, and session metadata where available.
- Use PTY keystroke injection only as a fallback control path.
- Load minimal Agent View control into Run pi processes by default.
- Allow policy-based full extension loading for Run processes, guarded by nesting depth.
- Default launch nesting depth to 1: a Run cannot launch further Runs unless explicitly configured otherwise.
- Keep Pantheon/pi Specialist Markdown as the canonical Specialist definition format.
- Specialist precedence is session/launch-provided, project, user, bundled.
- Support session/launch-provided Specialists through a JSON flag and temporary Agent View UI creation.
- Use Pantheon-native temporary Specialist JSON fields, including `systemPrompt`, `noTools`, and `options`.
- Model selection is Specialist-first, with launch override and configuration-driven fallback.
- Preserve Pantheon-style fallback by modeling Run Attempts within a Run.
- A Run completes only when the active Attempt reaches a normal assistant final response.
- Canonical Run Status values are `queued`, `starting`, `running`, `needs_input`, `idle`, `completed`, `failed`, `stopped`, and `stale`.
- `queued` means waiting for Supervisor capacity.
- `needs_input` means explicitly blocked on user or Supervisor input.
- `idle` means waiting but not blocked.
- Support default reply plus advanced `steer` and `follow_up` input modes.
- Persist each Run's pi session file as the transcript source of truth.
- Persist a normalized Agent View event log for lifecycle, status, UI, and recovery events.
- Do not mirror full transcript content into the Agent View event log.
- Store artifact records for session, event log, PTY transcript or stdout/stderr, diff, patch, worktree, summary, debug trace, and result JSON.
- Record sanitized, text-only, size-capped PTY transcripts by default.
- Allow raw PTY recording only under explicit debug configuration.
- Generate row summaries with a dedicated Agent View summary model configured separately from Run models.
- Refresh summaries on status transitions and at a throttled cadence while Runs are running.
- Allow Runs to launch from Agent View UI and Agent View tools through the same Supervisor control path.
- Replace `pantheon_delegate`, `pantheon_council`, and `pantheon_background*` public orchestration tools with Agent View tools.
- Split single Run launch and Run Group launch into separate tools.
- Mandatory LLM-facing tools are launch, launch group, list, status, reply, stop, delete, result, diff, apply, project registration, and doctor checks.
- Keep attach and cleanup as user commands rather than LLM tools.
- Provide `/pantheon-agent-view` as canonical UI command and `/agents` as short alias.
- Provide guided launch, project registration, cleanup, cleanup-legacy, and doctor commands.
- Support structured launch UI and shorthand dispatch.
- Resolve shorthand conflicts by giving Specialist names precedence over project names.
- Show resolved shorthand target before launch.
- Confirm write-capable shorthand launches by default, with trusted config opt-out.
- Use policy-based auto-dispatch: read-only/research Runs may launch automatically; write-capable Runs require confirmation unless trusted config opts out.
- Apply separate project-scoped and user-scoped concurrency limits.
- Apply a separate project write-capable Run concurrency limit.
- Queue automatically when concurrency limits are reached.
- User-scoped Runs are read/research/coordinator only.
- Code edits happen through project-scoped Runs.
- Write-capable project-scoped Runs use isolated git worktrees by default when a git root exists.
- Allow explicit opt-out from worktree isolation.
- Warn before writing in place for non-git projects.
- Create project worktrees in a sibling directory named from the project plus package worktree suffix, with per-Run child directories.
- Name worktree branches descriptively using Agent View, Specialist, task slug, and short Run ID.
- Auto-clean empty or unchanged worktrees.
- Retain changed worktrees until Run deletion or explicit cleanup after apply.
- Review worktree results diff-first.
- Require explicit confirmation to apply or merge worktree changes into the main project.
- Support patch application for uncommitted changes.
- Support branch/commit merge paths if commits exist.
- Do not have write-capable Runs commit their own changes by default.
- Do not create pull requests in v1.
- Detect changed files and diffs with git diff when available, supplemented by tool-event tracking as fallback.
- Model Run Result as final assistant message reference plus derived metadata: summary, artifacts, changed files, diff path, and status.
- Model Council, parallel delegation, and chain delegation as Run Groups.
- Chained Run Groups store structured dependencies and may support `{previous}` placeholder expansion.
- Stopping a Run stops execution and preserves artifacts.
- Deleting a Run removes registry, session, and worktree artifacts after confirmation.
- Stale read-only Runs may auto-respawn.
- Stale write-capable Runs require user confirmation before resuming.
- Retain failed, stale, input-blocked, and write-capable Runs until explicit deletion.
- Prune completed read-only Runs by configurable age/count.
- Discover projects through known Runs and explicit registration, not broad filesystem scanning.
- Project registration stores canonical root path, project ID/hash, display name, and last-seen timestamp.
- Add an `agentView` section to existing package configuration and schema.
- Minimum Agent View config includes enablement, summary model, project/user concurrency limits, project write concurrency limit, summary refresh interval, trusted auto-launch, read-only auto-respawn, write-run confirmation, and worktree enablement/location.
- Provide cleanup-only handling for legacy debug/background artifacts; do not import legacy artifacts into Agent View.
- Track pi core gaps explicitly if package-level workarounds prove too brittle for robust attach/control.
- Land as one massive implementation issue/PR rather than phased slices.

## Testing Decisions

- Tests should assert external behavior and stable contracts rather than internal implementation details.
- Registry tests should verify Run, Attempt, Run Group, artifact, project registration, and retention behavior through public registry interfaces.
- Config tests should verify `agentView` defaults, project/global merging, schema validation, and trusted/safety policy resolution.
- JSON-RPC tests should verify Supervisor launch, list, status, reply, stop, delete, result, diff, apply, doctor, and error responses.
- TerminalBackend tests should use a fake backend for attach, detach, resize, input, output, stop, and failure degradation behavior.
- Process-level smoke tests should verify a Supervisor can launch a controlled Run process, observe lifecycle events, send input through sidecar control, stop it, and retain artifacts.
- Sidecar control tests should verify token authentication, lifecycle event delivery, structured reply/steer/follow-up routing, and graceful disconnect handling.
- Worktree tests should verify sibling directory selection, branch naming, write-capable isolation defaults, non-git warnings, empty worktree cleanup, changed worktree retention, diff generation, patch apply, and merge-path behavior.
- Run Group tests should verify council, parallel, and chain dependency orchestration, including `{previous}` expansion and structured dependency records.
- Summary tests should verify dedicated summary model selection, status-transition refresh, running throttle behavior, and cached summary persistence without requiring real model calls.
- Permission policy tests should verify read-only auto-dispatch, write confirmation, trusted opt-out, user-scope read/research restriction, and depth guard behavior.
- UI tests should cover grouping defaults, grouping toggles, shorthand resolution, resolved target display, write-capable confirmation, detail-pane fallback, and command behavior where practical.
- Legacy cleanup tests should verify old artifacts are detected and cleanup is explicit without importing legacy state into Agent View.
- Prior art in this repository includes existing tests for config loading, background lifecycle, command/tool registration, multiplexer behavior, setup/scaffolding, and cartography; new tests should follow the same pattern of exercising public behavior through focused module interfaces.
- The big bang cannot be considered done without unit tests for registry/config/schema/worktree behavior, JSON-RPC Supervisor integration tests, process-level Run lifecycle smoke tests, and PTY attach tests through backend abstraction rather than brittle real-terminal goldens.

## Out of Scope

- Creating pull requests from Run results.
- Making Runs commit their own changes by default.
- Importing legacy background/debug artifacts into the new Agent View model.
- Preserving `pantheon_delegate`, `pantheon_council`, or `pantheon_background*` as compatibility aliases.
- Broad filesystem scanning for projects.
- Making Claude `.claude/agents/*.md` definitions canonical.
- Full parity with Claude Code agent teams beyond representing council, parallel, and chain workflows as Run Groups.
- Raw PTY recording by default.
- Requiring pi core changes before attempting package-level implementation.
- Phased public migration or multiple implementation PRs.

## Further Notes

- The terminology and boundaries are recorded in the project domain glossary.
- The architectural decision to use a detached Supervisor with PTY-backed real pi sessions is recorded in the Agent View ADR.
- The chosen approach deliberately accepts significant integration and review risk in exchange for one coherent public rewrite.
- The implementation should extract deep modules around registry, Supervisor protocol, TerminalBackend, sidecar control, worktree management, Specialist resolution, policy resolution, Run Group orchestration, summary generation, retention, and legacy cleanup.
- The docs update must include a dedicated Agent View guide, README updates, tool/workflow/configuration updates, schema updates, codemap updates, and breaking migration notes.
