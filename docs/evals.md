# Pantheon Orchestration Evals

This guide explains how to evaluate whether the Pantheon orchestration layer is actually working rather than only appearing to work.

## Evaluation layers

Pantheon evals in this repo are split into four layers:

1. **Deterministic scenario evals**
   - fake runners and controlled fixtures
   - best for routing, fallback, recovery, and output-contract regressions
2. **Golden trace / approval fixtures**
   - protects timeline, progress, and report rendering from subtle drift
3. **Benchmark harness**
   - compares orchestrated workflows against simpler baseline fixtures
4. **Stats / reporting integration**
   - records eval outcomes so `/pantheon-stats` can surface them

## Scenario corpus

Scenario definitions live in:

- `evals/scenarios/*.json`

Current scenarios cover:

- delegate fallback recovery
- council synthesis progress
- background retry recovery
- adapter local-docs routing
- doctor/config diagnostics guidance

## Running evals

### Fast suite for PRs and routine local validation

Use this when changing orchestration behavior but you want feedback quickly:

```bash
npm test -- tests/orchestration-evals.test.ts tests/orchestration-approval.test.ts tests/orchestration.test.ts tests/ui-rendering-approval.test.ts
```

This fast suite is the recommended **PR-safe** cadence because it covers:

- deterministic scenario contracts
- approval fixtures for visible progress/report drift
- runtime/state helpers used by the eval harness
- report and widget rendering regressions

### Full suite for release candidates or periodic deep validation

Use this before publishing, cutting a release, or after major orchestration refactors:

```bash
npm test
npm run typecheck
npm run eval:orchestration
npm run pack:dry
```

This full suite adds:

- the entire repo test corpus
- benchmark comparisons against baseline fixtures
- package/publish smoke validation

### Run only the benchmark harness

```bash
npm run eval:orchestration
```

To emit machine-readable output:

```bash
npm run eval:orchestration -- --json
```

To write the report against a different workspace:

```bash
npm run eval:orchestration -- --cwd /path/to/worktree
```

## Output artifacts

The benchmark harness writes:

- `.oh-my-opencode-pi-evals.json`

This file stores recent orchestration eval runs and summary counts such as:

- scenarios run / passed / failed
- benchmark runs
- orchestration wins vs baseline wins
- fallback recoveries
- routing mismatches

`/pantheon-stats` reads this report and includes the eval summary in the rendered stats view.

## Updating approval fixtures safely

Approval fixtures live under:

- `tests/fixtures/orchestration-*.txt`

Only update them when:

- the orchestration timeline intentionally changed
- the command-progress UX intentionally changed
- the doctor/config report intentionally changed

Do **not** update them just to make a failing test go green without understanding the behavioral change.

## Interpreting failures

### Deterministic scenario failures

Usually mean one of these regressed:

- fallback did not trigger
- council no longer emits progress
- background retry no longer recovers
- adapter routing changed
- doctor/config guidance regressed

### Approval fixture failures

Usually mean the visible orchestration contract changed:

- progress wording
- trace ordering
- report structure
- recovery guidance text

### Benchmark regressions

Look for:

- fewer orchestration wins
- lower quality scores
- routing mismatches
- lost fallback recoveries

## Suggested workflow

### Day-to-day / PR workflow

1. run the fast suite
2. run any extra focused tests for the area you touched
3. inspect approval diffs before updating fixtures
4. only update fixtures when the behavior change is intentional

### Release / milestone workflow

1. run the full suite
2. inspect `npm run eval:orchestration` output for benchmark wins, ties, and regressions
3. inspect `/pantheon-stats` or `.oh-my-opencode-pi-evals.json`
4. verify package output with `npm run pack:dry`
5. only then publish or tag a release

This split is intentional: keep PR checks fast enough to run often, and reserve the broader benchmark/package pass for release candidates, nightly automation, or larger orchestration changes.
