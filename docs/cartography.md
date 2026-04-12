# Cartography Skill

Cartography is the bundled repository-mapping skill in `oh-my-opencode-pi`.

It helps the orchestrator build and maintain a hierarchical `codemap.md` view of a repository so future work starts from architecture summaries instead of raw file spelunking.

## What it does

Cartography in this port is built around:

1. a prompt skill at `skills/cartography/SKILL.md`
2. low-level mapping tools: `pantheon_repo_map` and `pantheon_code_map`
3. an incremental state file: `.pi/cartography.json`
4. generated `codemap.md` files for the repo root and important folders

## How to use it

### In pi

Ask the orchestrator to run cartography, or use the dedicated skill command when skill commands are enabled:

```text
/skill:cartography
```

### Manual script usage

The bundled script supports upstream-style init / changes / update flows:

```bash
node ./skills/cartography/scripts/cartographer.mjs init \
  --root . \
  --include "extensions/**/*.ts" \
  --include "bin/*.mjs" \
  --include "package.json" \
  --exclude "tests/**" \
  --exclude "node_modules/**"

node ./skills/cartography/scripts/cartographer.mjs changes --root .
node ./skills/cartography/scripts/cartographer.mjs update --root .
```

## Outputs

Typical outputs are:

- `.pi/cartography.json`
- root `codemap.md`
- folder-level `codemap.md` files
- an `AGENTS.md` repository-map section if missing

## What changed vs upstream

The upstream package stores state under `.slim/`. This pi port stores state under:

```text
.pi/cartography.json
```

Otherwise the workflow is intentionally similar: detect tracked folders, create codemap templates, then update only the areas that changed.

## Recommended mapping scope

Usually include:

- `extensions/`
- `bin/`
- `agents/`
- `prompts/`
- `skills/`
- core manifests like `package.json` and `tsconfig.json`

Usually exclude unless needed:

- `node_modules/`
- generated output
- snapshot/fixture directories
- most test-only directories when building architecture maps

## Why it matters

Cartography gives agents:

- faster onboarding to unfamiliar repos
- lower token usage on repeated tasks
- better architecture-aware edits
- durable technical documentation that survives implementation churn

See also:

- [skills.md](skills.md)
- [tools.md](tools.md)
- `skills/cartography/SKILL.md`
