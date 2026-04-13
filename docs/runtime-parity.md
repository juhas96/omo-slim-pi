# Runtime Parity

`oh-my-opencode-pi` is inspired by `oh-my-opencode-slim`, but it runs inside **pi**, not OpenCode.

That means this package aims for **product-level parity where possible**, not byte-for-byte runtime equivalence.

## What maps cleanly

These upstream ideas map well to pi and are implemented directly in this port:

- orchestrator-style top-level guidance
- specialist delegation via `pantheon_delegate`
- council-style consensus via `pantheon_council`
- detached/background specialist work
- repo mapping and semantic code-map tooling
- workflow state, resume context, and auto-continue helpers
- docs/package/release/web research through adapters
- pi-native LSP, format, patch, and AST-grep code tools
- debug traces, runtime inspection, and usage statistics

## What is pi-native rather than upstream-identical

Some surfaces exist in this port, but the implementation is intentionally pi-specific:

### Adapters instead of MCP runtime parity

Upstream MCP guidance maps to the pi adapter layer here.

Use:

- `pantheon_adapter_list`
- `pantheon_adapter_health`
- `pantheon_adapter_search`
- `pantheon_adapter_fetch`
- `pantheon_webfetch`
- `pantheon_fetch_docs`

This covers the practical jobs users need, but not exact OpenCode MCP runtime behavior.

### Spec studio instead of `/interview`

The browser-based upstream `/interview` flow is not ported directly.

Use the pi-native replacement instead:

- command: `/pantheon-spec-studio`
- tool: `pantheon_spec_template`

### Command/UI presentation

Pantheon in pi uses editor reports, widgets, local overlays, and optional chat output depending on the command surface.

That means UX behavior can be intentionally different from upstream while still solving the same workflow problem.

## Known parity gaps and limits

These areas should be treated as **similar in intent, not identical in mechanics**:

- OpenCode agent registry integration
- exact OpenCode hook/interception semantics
- exact MCP server/runtime semantics
- exact `apply_patch` rescue behavior
- exact detached-session lifecycle behavior
- any browser-only or OpenCode-TUI-specific interaction model

## Practical expectations for users

If you are moving from upstream docs to this port:

1. prefer the pi docs in this package over upstream command examples
2. expect adapter-based research instead of MCP-specific workflows
3. expect editor/widget/modal result surfaces instead of exact upstream UI behavior
4. treat parity notes as product guidance, not bug reports by default

## When something is a bug vs a parity difference

It is probably a **bug** when:

- documented pi commands/tools do not work as described
- a result is incorrectly routed to chat/editor/widget/modal surfaces
- background tasks, adapters, config loading, or command flows regress unexpectedly

It is probably a **parity difference** when:

- the upstream feature depends on OpenCode-specific runtime behavior
- the pi port exposes the same workflow through a different command or tool
- the UX is different, but the user outcome is still supported

## Related docs

- [quick-reference.md](quick-reference.md)
- [tools.md](tools.md)
- [mcps.md](mcps.md)
- [interview.md](interview.md)
- [configuration.md](configuration.md)
