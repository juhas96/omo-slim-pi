---
name: karpathy-guidelines
description: Behavioral guardrails for implementation, review, and refactor work. Use when writing or changing code to surface assumptions, prefer the simplest solution, keep diffs surgical, and define concrete verification before claiming success.
license: MIT
---

# Karpathy Guidelines

Behavioral guardrails for non-trivial coding work, adapted for Pantheon/pi from Forrest Chang's MIT-licensed skill based on Andrej Karpathy's observations about common LLM coding mistakes.

Use this as a behavior layer for implementation, bug fixing, refactors, and reviews. It complements domain-specific skills such as `cartography`; it does not replace them.

**Tradeoff:** These guidelines bias toward caution over speed. For tiny obvious edits, use judgment.

## When to Use

Use this skill when:

- implementing or refactoring non-trivial code
- fixing bugs where assumptions or scope drift are risky
- reviewing a planned change before editing
- a task could easily balloon into overengineering
- the user wants high-confidence, minimal diffs

## Core Principles

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface trade-offs.**

Before editing:

- state the assumptions you are making
- if multiple interpretations exist, surface them instead of choosing silently
- ask clarifying questions when uncertainty could change the implementation
- push back when a simpler path would better fit the request
- if something is confusing, say what is unclear before coding

### 2. Simplicity First

**Solve the requested problem with the minimum code necessary.**

Prefer:

- the smallest change that satisfies the request
- straightforward code over reusable-looking abstractions
- existing patterns over speculative new layers
- explicit code over flexibility that was not requested

Avoid:

- extra features
- new abstractions for single-use code
- future-proofing that was not asked for
- defensive branches for impossible scenarios

Sanity check: if the change feels 3x larger than the problem, simplify it.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own fallout.**

When editing existing code:

- keep every changed line traceable to the user's request
- avoid drive-by refactors, style rewrites, or comment churn
- match the surrounding style unless the user asked for standardization
- mention unrelated issues you notice, but do not fix them silently

Clean up only what your change made unnecessary, such as:

- unused imports
- dead variables introduced by your change
- helper code you added and then replaced

Do not remove unrelated pre-existing dead code unless asked.

### 4. Goal-Driven Execution

**Translate requests into verifiable success criteria, then loop until verified.**

Prefer goals like:

- "write a failing reproduction, then make it pass"
- "add validation tests for invalid input, then implement the guard"
- "preserve existing behavior before and after the refactor"

For multi-step work, use a short plan with verification:

```text
1. Inspect current behavior → verify: identify exact files and failure mode
2. Make the smallest change → verify: targeted test or diagnostic passes
3. Clean up fallout → verify: no unused imports or broken references remain
```

Do not claim success without evidence.

## Practical Workflow

1. Clarify scope and assumptions.
2. State the minimal plan and the check for each step.
3. Implement only the requested delta.
4. Verify with tests, diagnostics, or direct inspection.
5. Report changed files, evidence, and any follow-up items separately.

## Red Flags

Stop and reassess if you are about to:

- invent a new abstraction before proving it is needed
- edit adjacent code "while you're here"
- add configurability that nobody requested
- skip verification because the change "looks right"
- continue despite unresolved ambiguity

## Output Expectations

A strong response after using this skill usually includes:

- key assumptions or clarifications
- a short, verification-oriented plan for non-trivial work
- minimal changed files
- concrete validation results
- separate notes for unrelated follow-up work
