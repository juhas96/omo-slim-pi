# Pantheon Orchestration Diagram

This note explains how the automated orchestration system in `oh-my-opencode-pi` works at a high level.

## End-to-end flow

```mermaid
flowchart TD
    A[pi session starts] --> B[Load Pantheon config<br/>built-ins + global + project]
    B --> C[Restore orchestration snapshot<br/>and workflow state]
    C --> D[Reconcile background tasks<br/>start poller/dashboard]
    D --> E[before_agent_start hook]
    E --> F[Append orchestrator prompt<br/>+ workflow hints]
    F --> G[Top-level agent turn]

    G --> H{How should work run?}

    H -->|Direct| I[Agent uses normal tools<br/>read/edit/write/bash/etc.]
    H -->|Delegate| J[pantheon_delegate]
    H -->|High-stakes decision| K[pantheon_council]
    H -->|Detached / long-running| L[pantheon_background]

    J --> J1[Discover specialist agents]
    J1 --> J2[Single / Parallel / Chain execution]
    J2 --> J3[Stream subagent activity<br/>record debug traces]
    J3 --> M[Return summarized result]

    K --> K1[Run councillors in parallel]
    K1 --> K2[Council master synthesizes]
    K2 --> M

    L --> L1[Write task spec/log/result files]
    L1 --> L2[Launch detached runner]
    L2 --> L3[Heartbeat + reconcile + retry/attach/watch]
    L3 --> N[Background result available later]

    I --> O[tool_result hook]
    M --> O
    N --> O

    O --> P[Record stats + hook trace]
    P --> Q[Update dashboard / widgets / notifications]
    Q --> R[agent_end hook]
    R --> S[Extract unchecked todos]
    S --> T[Persist workflow state]
    T --> U{Auto-continue enabled
and todos remain?}
    U -->|Yes| V[Send follow-up user message<br/>Continue working through remaining todos]
    U -->|No| W[Wait for next user turn]
    V --> G
    W --> X[Session shutdown]
    X --> Y[Persist orchestration snapshot]
```

## Main runtime pieces

- `extensions/oh-my-opencode-pi/index.ts` — composition root for hooks, tools, commands, dashboard, and routing
- `extensions/oh-my-opencode-pi/config.ts` — config loading, merge order, and sanitization
- `extensions/oh-my-opencode-pi/orchestration.ts` — hook-event snapshot and trace model
- `extensions/oh-my-opencode-pi/workflow.ts` — todo extraction, persistence, resume context, workflow hints
- `extensions/oh-my-opencode-pi/background.ts` — detached task lifecycle, heartbeats, retry, stale detection, tmux attach
- `extensions/oh-my-opencode-pi/agents.ts` — specialist discovery and prompt/model overrides
- `agents/orchestrator.md` — top-level orchestration guidance appended to the main agent

## Mental model

- **Hooks** shape the top-level session behavior.
- **Prompt injection** teaches the main agent how to route work.
- **Delegation** runs one or more specialists in isolated contexts.
- **Council** provides multi-model consensus.
- **Background tasks** detach long-running work from the foreground turn.
- **Workflow state** preserves unchecked todos and recent task context.
- **Observability** comes from stats, debug traces, and orchestration snapshots.
