# Council Guide

The Council is Pantheon's multi-model consensus workflow for pi. It runs several councillors in parallel, then asks a council master to synthesize the best final answer.

## Overview

Use the Council when one good answer is not enough:

- architecture decisions
- risky refactors
- ambiguous debugging paths
- reviews where blind spots are expensive
- trade-offs where you want disagreement before action

If the task is routine and implementation-heavy, prefer `pantheon_delegate` or direct execution instead.

---

## How it works

```text
Prompt
  │
  ├── Councillor A
  ├── Councillor B
  ├── Councillor C
  │
  └── Council master synthesizes the responses
          │
          ▼
   Final consolidated answer
```

Councillors run in isolated subagent contexts. The master receives their outputs and produces the final verdict.

---

## Ways to invoke it

### Interactive command

```text
/pantheon-council
```

### Prompt template

```text
/ask-council should we move this module behind an event bus?
```

### Tool call

- `pantheon_council`

Example tool payload:

```json
{
  "prompt": "Should we split this service into separate read/write modules?",
  "preset": "review-board"
}
```

---

## Built-in council presets

The package ships with these defaults:

- `default` — 3 councillors
- `quick` — 1 councillor for low-overhead second opinions
- `balanced` — 2 councillors for faster trade-off review
- `review-board` — `reviewer`, `architect`, and `skeptic` roles plus stronger master guidance

You can override any preset in config.

---

## Example configuration

```jsonc
{
  "council": {
    "defaultPreset": "review-board",
    "masterTimeoutMs": 300000,
    "councillorsTimeoutMs": 180000,
    "presets": {
      "review-board": {
        "master": {
          "model": "anthropic/claude-sonnet-4-5",
          "variant": "high",
          "prompt": "Prioritize correctness and operational simplicity."
        },
        "councillors": [
          {
            "name": "reviewer",
            "model": "openai/gpt-4.1",
            "prompt": "Review for bugs, correctness, and edge cases."
          },
          {
            "name": "architect",
            "model": "anthropic/claude-sonnet-4-5",
            "prompt": "Look for architecture risk and maintainability issues."
          },
          {
            "name": "skeptic",
            "model": "google/gemini-2.5-pro",
            "prompt": "Challenge assumptions and propose simpler alternatives."
          }
        ]
      }
    }
  }
}
```

---

## Timeouts and fallback behavior

Relevant config:

- `council.masterTimeoutMs`
- `council.councillorsTimeoutMs`
- `fallback.councilMaster`
- `fallback.retryOnEmpty`

Defaults are intentionally longer than foreground delegate runs because council work is higher-latency by nature.

---

## When to use Council vs Delegate

Use `pantheon_council` when:

- you need multiple perspectives
- the decision is expensive to reverse
- you want explicit challenge and synthesis

Use `pantheon_delegate` when:

- one specialist is enough
- the task is mostly execution
- you already know which role you need

---

## Tips for good council results

- Use a strong synthesis model for the master.
- Keep councillors diverse across providers or reasoning styles.
- Give each councillor a distinct role prompt.
- Use `quick` for low-cost checks and `review-board` for serious decisions.
- If answers are too similar, increase model diversity rather than adding more identical councillors.

See also:

- [provider-configurations.md](provider-configurations.md)
- [configuration.md](configuration.md)
- [tools.md](tools.md)
