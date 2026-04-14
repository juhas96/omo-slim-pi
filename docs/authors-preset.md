# Author-style Preset

This repository does not claim a single canonical "daily driver" config, but this preset is a strong practical starting point for the pi port and is intentionally close in spirit to the upstream author's mixed-model setup.

It uses:

- a stronger reasoning model for `oracle`
- fast models for `explorer` and `librarian`
- a visually capable model for `designer`
- a diverse `review-board` council
- durable retries, debug traces, and adapter restrictions

## Example preset

```jsonc
{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["research", "durable"],
  "agents": {
    "oracle": {
      "model": "anthropic/claude-sonnet-4-5",
      "variant": "high"
    },
    "explorer": {
      "model": "openai/gpt-5.4-mini",
      "allowSkills": ["cartography"],
      "allowedAdapters": ["local-docs", "github-code-search", "web-search"]
    },
    "librarian": {
      "model": "openai/gpt-5.4-mini",
      "allowedAdapters": ["local-docs", "docs-context7", "npm-registry", "github-releases", "web-search"]
    },
    "designer": {
      "model": "google/gemini-2.5-pro"
    },
    "fixer": {
      "model": "openai/gpt-5.4"
    }
  },
  "council": {
    "defaultPreset": "review-board",
    "presets": {
      "review-board": {
        "master": {
          "model": "anthropic/claude-sonnet-4-5",
          "variant": "high",
          "prompt": "Prioritize correctness, maintainability, and operational simplicity."
        },
        "councillors": [
          { "name": "reviewer", "model": "openai/gpt-5.4" },
          { "name": "architect", "model": "anthropic/claude-sonnet-4-5" },
          { "name": "skeptic", "model": "google/gemini-2.5-pro" }
        ]
      }
    }
  },
  "fallback": {
    "retryOnEmpty": true,
    "retryDelayMs": 750,
    "agentChains": {
      "explorer": ["openai/gpt-5.4-mini"],
      "librarian": ["openai/gpt-5.4-mini"],
      "fixer": ["openai/gpt-5.4-mini"]
    },
    "councilMaster": ["openai/gpt-5.4"]
  },
  "skills": {
    "defaultAllow": ["cartography"],
    "cartography": {
      "enabled": true,
      "maxFiles": 250,
      "maxDepth": 4,
      "maxPerDirectory": 8
    }
  },
  "multiplexer": {
    "tmux": true,
    "layout": "main-vertical",
    "focusOnSpawn": false,
    "projectScopedWindow": true
  },
  "debug": {
    "enabled": true
  }
}
```

## Why this works well

- `oracle` gets the highest-quality reasoning path.
- `explorer` and `librarian` stay fast enough for repeated scouting.
- `designer` gets a model suited to broader UI synthesis.
- council diversity is real, not cosmetic.
- cartography is available by default for repo-mapping work.
- debug traces stay on for postmortems.

Tune it from there based on cost, latency, and which providers you trust most in pi.
