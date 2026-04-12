# Installation Guide

Complete installation instructions for `oh-my-opencode-pi`.

## Table of Contents

- [Project-local install](#project-local-install)
- [Global install](#global-install)
- [Standalone installer CLI](#standalone-installer-cli)
- [Verification](#verification)
- [After installation](#after-installation)
- [For LLM agents](#for-llm-agents)
- [Troubleshooting](#troubleshooting)

---

## Project-local install

Install the package into the current repository so only that project sees the Pantheon extension, prompts, and bundled skills:

```bash
pi install -l /absolute/path/to/oh-my-opencode-pi
```

This is the best default when you want the port enabled for one repository without changing your global pi setup.

---

## Global install

Install it once for your whole pi environment:

```bash
pi install /absolute/path/to/oh-my-opencode-pi
```

Use global install when you want Pantheon available in every repository you open with pi.

---

## Standalone installer CLI

This package also ships a small installer/onboarding CLI for creating project-local Pantheon scaffolding.

The generated config includes explicit OpenAI defaults for delegated specialists (`oracle`, `explorer`, `librarian`, `designer`, `fixer`) plus a `review-board` council preset. The top-level pi session model still comes from pi itself.


```bash
node ./bin/oh-my-opencode-pi.mjs install --cwd /path/to/project --tmux=yes --skills=yes
node ./bin/oh-my-opencode-pi.mjs verify --cwd /path/to/project
```

If installed from npm and the binary is on your `PATH`, the same commands work as:

```bash
oh-my-opencode-pi install --cwd /path/to/project --tmux=yes --skills=yes
oh-my-opencode-pi verify --cwd /path/to/project
```

### Installer flags

| Option | Description |
|--------|-------------|
| `--cwd <dir>` | Target project directory |
| `--global` | Write into the global pi agent directory instead of a project `.pi/` folder |
| `--reset` | Overwrite generated bootstrap files |
| `--yes` | Reserved for non-interactive automation flows |
| `--tmux=yes|no` | Enable tmux-based multiplexer integration in the generated config |
| `--skills=yes|no` | Enable the bundled cartography skill in the generated config |

---

## Verification

After installation, open pi in the target repository and confirm the Pantheon commands exist.

Useful checks:

```text
/pantheon
/pantheon-config
/pantheon-agents
/pantheon-runtime
```

You can also verify installer output directly:

```bash
oh-my-opencode-pi verify --cwd /path/to/project
```

---

## After installation

A good first-run flow is:

1. run `/pantheon-config` to inspect active config sources and warnings
2. run `/pantheon` to open the command center
3. run `/pantheon-agents` to confirm bundled specialists are loaded
4. run `/pantheon-skills` to inspect effective skill guidance
5. if you want repository mapping, run `/skill:cartography`
6. if you want project-local overrides, run `/pantheon-bootstrap`

If you prefer the tool surface instead of slash commands, the top-level orchestrator can call:

- `pantheon_delegate`
- `pantheon_council`
- `pantheon_background`
- `pantheon_bootstrap`
- `pantheon_spec_template`

---

## For LLM agents

If another coding agent needs to install this package, give it one of these pointers:

```text
Install and configure by following the instructions in docs/installation.md and docs/provider-configurations.md in this repository.
```

Or point it at the root README if you want the higher-level overview first.

---

## Troubleshooting

### Config appears to be ignored

Check both supported config locations:

- global: `~/.pi/agent/oh-my-opencode-pi.json` or `.jsonc`
- project-local: `.pi/oh-my-opencode-pi.json` or `.jsonc`

Project config is deep-merged on top of global config.

### `/pantheon` commands are missing

Make sure the package is actually installed in pi, then restart the session after installation.

### Tmux panes do not open

Multiplexer pane spawning requires:

- `multiplexer.tmux: true`
- a live tmux session (`$TMUX` set)
- background work launched through Pantheon tools/commands

### Custom prompts or adapters do not load

Use `/pantheon-config` and `/pantheon-adapters` to confirm the resolved config and effective adapter policy.

### Published package docs are missing

If you publish this package, keep `docs/` in the npm `files` list so the guides ship with the package.
