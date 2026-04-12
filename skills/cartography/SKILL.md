---
name: cartography
description: Repository understanding and hierarchical codemap generation. Use when mapping an unfamiliar codebase, creating repository documentation, or refreshing codemap.md files after structural changes.
---

# Cartography Skill

You help users understand and map repositories by creating and maintaining hierarchical `codemap.md` files.

This skill is the preferred user-facing surface for repository mapping. Treat `pantheon_repo_map` and `pantheon_code_map` as low-level building blocks used by this workflow, not as dedicated slash-command UX.

The bundled script `scripts/cartographer.mjs` provides upstream-style incremental state tracking. In this pi port, the state file lives at `.pi/cartography.json`.

## When to Use

- User asks to understand or map a repository
- User wants codebase documentation or an architecture atlas
- Starting work on an unfamiliar codebase
- Structural changes have made existing codemaps stale

## Workflow

### Step 1: Check existing state

First inspect whether the repository already has:
- `.pi/cartography.json`
- a root `codemap.md`
- directory-level `codemap.md` files
- an `AGENTS.md` section that points future agents at the codemap

If `.pi/cartography.json` exists, prefer incremental refreshes over full rewrites.

### Step 2: Initialize if needed

If `.pi/cartography.json` does not exist, initialize cartography state with the bundled script.

Resolve the script path relative to this skill directory and run a command like:

```bash
node ./scripts/cartographer.mjs init \
  --root . \
  --include "src/**/*.ts" \
  --include "extensions/**/*.ts" \
  --include "bin/*.mjs" \
  --include "package.json" \
  --exclude "tests/**" \
  --exclude "**/*.test.*" \
  --exclude "node_modules/**" \
  --exclude "dist/**"
```

This creates:
- `.pi/cartography.json`
- a root `codemap.md` atlas template
- empty `codemap.md` files for tracked folders
- an idempotent `AGENTS.md` `## Repository Map` section if it is missing

### Step 3: Scope the mapping surface

Map core code and configuration only.

Prefer including:
- source directories (`src/`, `app/`, `packages/*/src/`, `extensions/`, `bin/`)
- key manifests and config (`package.json`, `tsconfig.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`)
- major integration boundaries and entrypoints

Exclude unless the user explicitly asks otherwise:
- tests (`tests/`, `__tests__/`, `*.test.*`, `*.spec.*`)
- docs-only areas (`docs/`, most `*.md` files besides codemaps/AGENTS/README when relevant)
- generated/build output (`dist/`, `build/`, `coverage/`, `.next/`, `target/`)
- dependencies (`node_modules/`)
- translations, snapshots, fixtures, and vendored assets

### Step 4: Detect changes when state exists

If `.pi/cartography.json` already exists, run the bundled script before editing codemaps:

```bash
node ./scripts/cartographer.mjs changes --root .
```

Use the reported affected folders to scope your refresh. The workflow should also ensure the root atlas template and `AGENTS.md` repository-map section still exist. After updating codemaps, persist the new snapshot:

```bash
node ./scripts/cartographer.mjs update --root .
```

### Step 5: Gather repository signals

Use the low-level mapping primitives:

1. `pantheon_repo_map`
   - gather tree shape
   - identify key files and top directories
   - understand repository boundaries

2. `pantheon_code_map`
   - gather entrypoints
   - inspect import edges and hotspots
   - identify important symbols, directory roles, and cycles

Also use direct file reads for the most important entrypoints before writing codemaps.

### Step 6: Create or update directory codemaps

For each important mapped directory, create or refresh that directory's `codemap.md`.

Keep each directory codemap concise and technical. Prefer sections like:
- `Responsibility`
- `Key Files`
- `Design / Patterns`
- `Flow`
- `Integration Points`

Document:
- what the directory is for
- how control/data moves through it
- what other modules depend on it
- what patterns or boundaries are important

### Step 7: Finalize the root atlas

Create or update the root `codemap.md` as the master entry point.

It should usually include:
- repository purpose / responsibility
- system entry points
- a directory map table linking to subdirectory `codemap.md` files
- key architecture notes and integration boundaries

Prefer relative links to sub-maps.

### Step 8: Register the codemap in `AGENTS.md`

Ensure `AGENTS.md` in the repo root contains a `## Repository Map` section pointing agents to `codemap.md`.

If the section already exists, do not duplicate it.

Recommended section:

```md
## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- project architecture and entry points
- directory responsibilities and design patterns
- data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
```

## Codemap Quality Bar

Use precise technical language.

Capture:
- **Responsibility** — what architectural role the directory/module plays
- **Patterns** — factories, adapters, registries, middleware, orchestration layers, etc.
- **Flow** — how requests, data, or control move through the area
- **Integration points** — imports, consumers, adapters, hooks, APIs, CLIs, background jobs

Avoid:
- line-by-line paraphrase
- exhaustive file dumps
- vague summaries like “handles stuff” or “contains utilities”

## Output Shape

Typical outputs from this skill are:
- `.pi/cartography.json`
- root `codemap.md`
- selected directory `codemap.md` files
- optional `AGENTS.md` repository-map section update

Be incremental and idempotent: refresh stale maps, preserve useful existing material, and avoid duplicate sections.
