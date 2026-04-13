# Interview / Spec Workflow

The upstream `oh-my-opencode-slim` repository ships a browser-based `/interview` flow. That exact feature is **not currently ported** to pi.

## Pi-native replacement

The closest replacement in this port is the spec workflow:

- command: `/pantheon-spec-studio`
- tool: `pantheon_spec_template`

This workflow opens an editor-first structured markdown template for one of these kinds:

- `feature`
- `refactor`
- `investigation`
- `incident`

It is designed for the same general job the upstream interview flow solves: turning a vague request into a structured implementation brief.

## When to use it

Use the spec workflow when:

- the problem is still fuzzy
- you want a more deliberate planning artifact before coding
- the work spans multiple implementation slices
- you want explicit validation, rollout, and risk sections

## Example

```text
/pantheon-spec-studio
```

Or via tool:

```json
{
  "kind": "feature",
  "title": "Add team-scoped audit log filtering",
  "context": "Admin users need faster filtering across large event volumes",
  "focusAreas": "permissions, performance, UX"
}
```

## Related note

This is an intentional pi-specific workflow choice rather than a browser-flow port.
