# Configuration Reference

Complete reference for `oh-my-opencode-pi` configuration.

## Config files

| File | Purpose |
|------|---------|
| `~/.pi/agent/oh-my-opencode-pi.json` | Global Pantheon config |
| `~/.pi/agent/oh-my-opencode-pi.jsonc` | Global Pantheon config with comments/trailing commas |
| `.pi/oh-my-opencode-pi.json` | Project-local overrides |
| `.pi/oh-my-opencode-pi.jsonc` | Project-local overrides with comments/trailing commas |

> If both `.jsonc` and `.json` exist in the same location, `.jsonc` is preferred.

## Merge order

Pantheon resolves config in this order:

1. built-in defaults
2. global config presets and global config
3. project config presets and project config
4. validation/sanitization

Project-local config is deep-merged on top of global config.

---

## JSONC support

All config files support JSONC features:

- `//` comments
- `/* ... */` comments
- trailing commas

---

## Prompt overrides

You do not need to edit package source to customize bundled specialists.

Per-agent options:

- `agents.<name>.promptOverrideFile`
- `agents.<name>.promptAppendFiles`
- `agents.<name>.promptAppendText`

Relative paths are resolved from the config file's directory.

Example:

```jsonc
{
  "agents": {
    "explorer": {
      "promptAppendFiles": ["./prompts/explorer-project-notes.md"],
      "promptAppendText": "Prefer reconnaissance before implementation."
    },
    "fixer": {
      "promptOverrideFile": "./prompts/fixer-override.md"
    }
  }
}
```

---

## Built-in top-level config presets

These can be selected via `preset` or `extends`:

- `default` — no extra changes
- `fast` — lower-overhead council/research defaults
- `research` — broader docs retrieval and stronger explorer/librarian bias
- `durable` — stronger retry/debug defaults

Example:

```jsonc
{
  "extends": ["research", "durable"]
}
```

---

## Built-in council presets

- `default`
- `quick`
- `balanced`
- `review-board`

See [council.md](council.md) for usage guidance.

---

## Example config

```jsonc
{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["research", "durable"],
  "appendOrchestratorPrompt": true,
  "agents": {
    "explorer": {
      "model": "anthropic/claude-sonnet-4-5",
      "variant": "high",
      "options": ["--tools", "read,bash"],
      "promptAppendText": "Prefer reconnaissance before broad implementation.",
      "promptAppendFiles": ["./prompts/explorer-project-notes.md"],
      "allowSkills": ["cartography"],
      "allowedAdapters": ["docs-context7", "grep-app", "web-search"]
    },
    "fixer": {
      "model": "openai/gpt-4.1",
      "promptOverrideFile": "./prompts/fixer-override.md",
      "deniedAdapters": ["grep-app"]
    }
  },
  "skills": {
    "setupHints": true,
    "defaultAllow": ["cartography"],
    "cartography": {
      "enabled": true,
      "maxFiles": 250,
      "maxDepth": 4,
      "maxPerDirectory": 8,
      "exclude": ["vendor"]
    }
  },
  "adapters": {
    "disabled": ["github-releases"],
    "defaultAllow": ["docs-context7", "web-search"],
    "modules": ["./pantheon-adapters/internal-docs.mjs"]
  },
  "council": {
    "defaultPreset": "review-board"
  },
  "fallback": {
    "timeoutMs": 15000,
    "delegateTimeoutMs": 0,
    "retryDelayMs": 500,
    "retryOnEmpty": true,
    "finalMessageGraceMs": 1500,
    "agentTimeouts": {
      "explorer": 120000,
      "librarian": 120000
    },
    "agentChains": {
      "fixer": ["openai/gpt-4.1-mini"],
      "librarian": ["openai/gpt-4.1-mini"]
    },
    "councilMaster": ["openai/gpt-4.1"]
  }
}
```

---

## Top-level option map

### Core

- `appendOrchestratorPrompt`
- `agents`
- `council`
- `fallback`
- `fallback.finalMessageGraceMs`

### Background execution

- `background.enabled`
- `background.pollIntervalMs`
- `background.logDir`
- `background.maxConcurrent`
- `background.reuseSessions`
- `background.heartbeatIntervalMs`
- `background.staleAfterMs`

### Multiplexer

- `multiplexer.tmux`
- `multiplexer.splitDirection`
- `multiplexer.layout`
- `multiplexer.focusOnSpawn`
- `multiplexer.keepPaneOnFinish`
- `multiplexer.reuseWindow`
- `multiplexer.windowName`
- `multiplexer.projectScopedWindow`

### Research / adapters

- `research.timeoutMs`
- `research.userAgent`
- `research.maxResults`
- `research.githubToken`
- `research.defaultDocsSite`
- `adapters.disableAll`
- `adapters.disabled`
- `adapters.defaultAllow`
- `adapters.defaultDeny`
- `adapters.modules`

### Package updates

- `updates.enabled`
- `updates.notify`
- `updates.checkIntervalHours`
- `updates.skipLocalCheckout`
- `updates.cacheFile`

### Skills

- `skills.setupHints`
- `skills.defaultAllow`
- `skills.defaultDeny`
- `skills.cartography.enabled`
- `skills.cartography.maxFiles`
- `skills.cartography.maxDepth`
- `skills.cartography.maxPerDirectory`
- `skills.cartography.exclude`

### Fallback / execution recovery

- `fallback.timeoutMs`
- `fallback.delegateTimeoutMs`
- `fallback.retryDelayMs`
- `fallback.retryOnEmpty`
- `fallback.finalMessageGraceMs`
- `fallback.agentTimeouts`
- `fallback.agentChains`
- `fallback.councilMaster`

`fallback.finalMessageGraceMs` controls how long Pantheon waits after a clear final assistant response before terminating a lingering child process. Increase it if a provider needs more teardown time; decrease it if foreground handoff still feels sluggish.

### Delegation / workflow

- `delegation.maxDepth`
- `autoContinue.enabled`
- `autoContinue.cooldownMs`
- `autoContinue.maxContinuations`
- `autoContinue.autoEnable`
- `autoContinue.autoEnableThreshold`
- `workflow.injectHints`
- `workflow.backgroundAwareness`
- `workflow.todoThreshold`
- `workflow.persistTodos`
- `workflow.stateFile`
- `workflow.phaseReminders`
- `workflow.postFileToolNudges`
- `workflow.delegateRetryGuidance`

### UI / debugging

- `ui.dashboardWidget`
- `ui.maxTodos`
- `ui.maxBackgroundTasks`
- `debug.enabled`
- `debug.logDir`

---

## Update-checker notes

The package update checker is intentionally quiet.

Recommended defaults:

```jsonc
{
  "updates": {
    "enabled": true,
    "notify": true,
    "checkIntervalHours": 24,
    "skipLocalCheckout": true
  }
}
```

Guidance:

- keep `notify: true` for normal installed package usage
- set `updates.enabled: false` if you intentionally pin package versions and do not want notices
- keep `skipLocalCheckout: true` when developing from a local clone or path install
- use `/pantheon-version` to inspect cached state
- use `/pantheon-update-check` to force a refresh

---

## Agent override fields

Each `agents.<name>` entry can define:

- `model`
- `variant`
- `options`
- `tools`
- `noTools`
- `promptOverrideFile`
- `promptAppendFiles`
- `promptAppendText`
- `allowSkills`
- `denySkills`
- `allowedAdapters`
- `deniedAdapters`
- `disabled`

---

## Recommended schema reference

```jsonc
{
  "$schema": "../oh-my-opencode-pi.schema.json"
}
```

For a project-local config in `.pi/oh-my-opencode-pi.jsonc`, `../oh-my-opencode-pi.schema.json` is the usual relative path. If you publish the package, you can also point `$schema` at the published schema URL.

Useful runtime inspection commands:

- `/pantheon-config` — structured effective-config report plus config diagnostics
- `/pantheon-doctor` — broader health check across config, adapters, tmux, and background storage
- `/pantheon-adapters` — current adapter policy report
- `/pantheon-adapter-health` — adapter readiness/auth check

Pantheon now surfaces stronger config diagnostics for:

- unknown keys
- invalid enum values
- missing prompt/config/module/schema files
- suspicious adapter ids that do not match built-in adapters

The JSON schema helps editor autocomplete and static validation.
The runtime diagnostics in `/pantheon-config` and `/pantheon-doctor` help catch the same classes of issues during execution.

See also:

- [provider-configurations.md](provider-configurations.md)
- [mcps.md](mcps.md)
- [skills.md](skills.md)
- [workflows.md](workflows.md)
- [runtime-parity.md](runtime-parity.md)
