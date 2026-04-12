# Pantheon runtime parity notes

This document records the current gap between `oh-my-opencode-pi` and the runtime model used by `oh-my-opencode-slim`.

## Pi hook surface available today

Pi gives the extension enough surface for meaningful orchestration via:
- `session_start`
- `session_shutdown`
- `before_agent_start`
- `agent_end`
- `turn_start`
- `tool_call`
- `tool_result`

These support:
- orchestrator prompt injection
- workflow hint injection
- tolerant edit rescue before execution
- post-tool nudges and retry guidance
- session/dashboard/background lifecycle handling

## What maps well

Current Pantheon behavior that cleanly fits pi's extension model:
- specialist delegation and council orchestration
- custom tools and commands
- UI selectors, widgets, statuses, and notifications
- background task lifecycle management
- tool interception before execution (`tool_call`)
- tool post-processing (`tool_result`)

## What still does not fully map

These remain partial or impossible without deeper pi changes:
- OpenCode agent registry integration
- OpenCode-specific `apply_patch` interception semantics
- full hook parity around provider/session internals
- complete MCP/OpenCode runtime semantics
- all detached-session orchestration features from the original runtime

## Practical implication

`oh-my-opencode-pi` can get very close on product behavior, but some exact parity items are fundamentally runtime-bound.

The current strategy is:
1. use pi's native hooks where possible
2. expose runtime state clearly in commands/tools
3. document what would require upstream pi changes or a fork

## Candidates for upstream pi improvements

If deeper parity becomes a priority, the most useful upstream/runtime additions would be:
- richer patch/edit interception hooks
- more provider-request/response interception affordances
- stronger detached-session management primitives
- more generic language-server integration hooks
