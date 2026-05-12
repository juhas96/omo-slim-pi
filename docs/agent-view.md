# Agent View

Agent View is the public orchestration surface for dispatching, monitoring, inspecting, and managing Specialist Runs.

## Commands

- `/pantheon-agent-view` — open Agent View.
- `/agents` — shorthand alias for Agent View.
- `/agents <task>` — launch a read-only project Run through the Agent View UI path.
- `/agents {"task":"...","temporarySpecialist":{...}}` — launch with a temporary Pantheon-native Specialist.
- Attach and cleanup remain command-only surfaces; LLM tools do not attach terminals or clean legacy artifacts directly.

## Tools

Agent View tools replace the legacy public orchestration tools:

- `agent_view_launch`
- `agent_view_launch_group`
- `agent_view_list`
- `agent_view_status`
- `agent_view_reply`
- `agent_view_stop`
- `agent_view_delete`
- `agent_view_result`
- `agent_view_diff`
- `agent_view_apply`
- `agent_view_register`
- `agent_view_doctor`

Legacy `pantheon_delegate`, `pantheon_council`, and `pantheon_background*` tools are not public registration aliases in the Agent View model.

## Run model

A Run has a `runId`, status, Specialist, project registration, Attempt history, artifacts, event log, optional worktree, and optional summary cache. Status values are:

`queued`, `starting`, `running`, `needs_input`, `idle`, `completed`, `failed`, `stopped`, `stale`.

Run Groups model parallel, chain, and council orchestration. Chain groups expand `{previous}` into downstream tasks. Council groups run councillors first and then a synthesis Run with structured councillor outputs.

## Storage and routing

Project Runs store artifacts under the project Agent View directory. User-scoped registration stores an explicit project index with project root, project ID/hash, display name, and last-seen timestamp. The user Supervisor only discovers explicitly registered projects and projects with known Runs.

## Policy

Read-only and research Runs may auto-dispatch. Write-capable or shell-mutating Runs require confirmation unless trusted config disables that guard. User-scoped Runs are limited to read/research/coordinator behavior. Nested launch depth defaults to `1`.

## Migration notes

Agent View is a breaking public orchestration replacement. Old background/debug artifacts are not imported. Use cleanup-only commands to remove legacy background artifacts explicitly after migration.

## Current pi-core gaps

This package includes the TerminalBackend interface, fake backend coverage, sidecar token model, and detail-pane degradation. Full native terminal takeover still depends on pi runtime/PTY integration availability; Agent View reports degraded mode when PTY attach is unavailable.
