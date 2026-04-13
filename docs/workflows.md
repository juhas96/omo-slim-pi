# Pantheon Workflows Guide

This guide explains how to choose the right Pantheon workflow, where results appear, and how to recover when something goes wrong.

## Start from the user intent

### I want to investigate or implement something bounded

Use `pantheon_delegate` when:
- one specialist is enough
- the task is clear
- you want a scout → plan → implement chain or a few parallel specialists

Good fits:
- repo reconnaissance
- architecture review
- focused implementation
- documentation lookup through `librarian`

### I want a high-confidence decision

Use `pantheon_council` when:
- the decision is high-impact
- trade-offs are ambiguous
- you want multiple perspectives before acting

Good fits:
- architecture choices
- migration plans
- risky refactors
- disagreements between implementation options

### I want work to continue while I keep moving

Use `pantheon_background` when:
- the work should continue detached from the foreground
- you want to keep moving while a specialist runs
- the task may take long enough that live inspection or retry matters

Good fits:
- broad investigations
- long-running code changes
- review passes you may want to inspect later

### I am resuming or recovering work

Start with:
- `/pantheon` → recommended actions
- `/pantheon-overview` → workflow + background state together
- `/pantheon-task-actions <taskId>` → one menu for watch/result/log/retry/attach/cancel
- `/pantheon-resume` → persisted todos + recent background context

---

## Where results appear

### Foreground command results

Commands like:
- `/pantheon-runtime`
- `/pantheon-config`
- `/pantheon-adapters`
- `/pantheon-result`

now use three consistent surfaces:

- **editor report** — full structured output
- **chat report** — labeled command result in the conversation timeline
- **command widget** — compact status + summary below the editor

Long-running delegate and council commands stream **running** widget updates while work is still in progress, then replace those partial summaries with the final result.

Use the editor report when you need the full output.
Use the widget when you only need quick confirmation of what command ran and what to do next.

`/pantheon-doctor` is slightly different: it stays in the editor + command widget (and uses a notification for warnings/errors) instead of posting a chat report.

### Subagent activity

Use:
- `/pantheon-subagents`

This is the best place to inspect:
- recent delegate/council activity
- per-subagent output
- traces for deeper debugging

### Background tasks

Use:
- `/pantheon-task-actions <taskId>` — best first stop; one menu for retry/cancel/log/result/watch/attach
- `/pantheon-backgrounds` — overview of recent work
- `/pantheon-watch <taskId>` — live state, heartbeat, and recent log tail
- `/pantheon-result <taskId>` — final summary plus next recovery actions
- `/pantheon-log <taskId>` — raw recent log output
- `/pantheon-attach <taskId>` — live tmux pane
- `/pantheon-retry <taskId>` — rerun terminal or stale tasks

Mental model:
- **watch** = what is happening right now
- **result** = what happened and what to do next
- **log** = raw output when you need detail
- **task-actions** = interactive recovery/inspection shortcut

### Code review helper

Use:
- `/review uncommitted` — review staged + unstaged local changes
- `/review committed [range]` — review a committed diff range (default `HEAD~1..HEAD`)
- `/review commit [sha]` — review a single commit (default `HEAD`)
- `/review pr [number|url|branch]` — review a pull request with `gh pr diff`

The command injects a defined review prompt modeled on obra/superpowers' code-reviewer checklist and tells the agent to inspect the diff directly before giving a merge verdict.

---

## Failure recovery workflows

### Delegate failed

1. inspect `/pantheon-subagents`
2. inspect `/pantheon-debug`
3. narrow the task
4. retry with a different specialist if needed
5. use `pantheon_background` if the task is large or noisy

### Council failed

1. narrow the question
2. try a different preset
3. inspect `/pantheon-subagents`
4. inspect `/pantheon-debug`
5. fall back to one specialist first, then re-run council if needed

### Background task failed or went stale

1. run `/pantheon-result <taskId>`
2. run `/pantheon-watch <taskId>`
3. run `/pantheon-log <taskId>` if you need raw output
4. if still useful, run `/pantheon-retry <taskId>`
5. if running inside tmux, use `/pantheon-attach <taskId>` for a live pane

---

## Research workflow tips

### Use local and structured sources first

Preferred order in most cases:
1. local docs
2. docs-aware adapters
3. package metadata/docs
4. repo-aware code search
5. generic web search

### Useful inspection commands

- `/pantheon-adapters` — effective policy for the current session
- `/pantheon-adapter-health` — readiness/auth status
- `/pantheon-config` — effective config report if policy behavior looks wrong
- `/pantheon-doctor` — broader health check when config/runtime behavior feels off

---

## Practical default playbook

### Implementing a bounded change

1. delegate to `explorer` if you need reconnaissance
2. delegate to `fixer` for implementation
3. run diagnostics/tests
4. inspect `/pantheon-subagents` if the result looks suspicious

### Making a risky decision

1. collect context
2. run `pantheon_council`
3. inspect the synthesized answer
4. check councillor details in `/pantheon-subagents`

### Running a long investigation

1. start with `pantheon_background`
2. keep working in foreground
3. periodically use `/pantheon-watch`
4. use `/pantheon-result` when it finishes

See also:
- [tools.md](tools.md)
- [evals.md](evals.md)
- [mcps.md](mcps.md)
- [configuration.md](configuration.md)
- [multiplexer-integration.md](multiplexer-integration.md)
