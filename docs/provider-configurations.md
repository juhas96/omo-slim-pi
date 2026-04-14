# Provider Configurations

`oh-my-opencode-pi` does not hard-code one provider stack. It uses pi model strings and per-agent overrides, so you can run a single-provider setup or mix providers by specialist.

## Config file location

Put provider choices in either:

- `~/.pi/agent/oh-my-opencode-pi.json` or `.jsonc`
- `.pi/oh-my-opencode-pi.json` or `.jsonc`

Project-local config overrides global config.

## How provider selection works in this port

Provider/model choice is configured per agent and per council preset. Typical places:

- `agents.<name>.model`
- `agents.<name>.variant`
- `council.presets.<preset>.master.model`
- `council.presets.<preset>.councillors[].model`
- `fallback.agentChains`
- `fallback.councilMaster`

Authentication is handled by pi and the configured provider environment, not by this package itself.

---

## Default-style OpenAI setup

A straightforward starting point:

```jsonc
{
  "extends": ["durable"],
  "agents": {
    "oracle": { "model": "openai/gpt-5.4", "variant": "high" },
    "explorer": { "model": "openai/gpt-5.4-mini", "variant": "low" },
    "librarian": { "model": "openai/gpt-5.4-mini", "variant": "low" },
    "designer": { "model": "openai/gpt-5.4-mini", "variant": "medium" },
    "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low" }
  },
  "council": {
    "defaultPreset": "review-board",
    "presets": {
      "review-board": {
        "master": { "model": "openai/gpt-5.4", "variant": "high" },
        "councillors": [
          { "name": "reviewer", "model": "openai/gpt-5.4" },
          { "name": "architect", "model": "openai/gpt-5.4-mini", "variant": "medium" },
          { "name": "skeptic", "model": "openai/gpt-5.4-mini", "variant": "medium" }
        ]
      }
    }
  }
}
```

---

## Mixed-provider setup

The pi port works best when you give different specialists different strengths.

```jsonc
{
  "extends": ["research", "durable"],
  "agents": {
    "oracle": {
      "model": "anthropic/claude-sonnet-4-5",
      "variant": "high"
    },
    "explorer": {
      "model": "openai/gpt-5.4-mini",
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
          "prompt": "Prioritize correctness and simplicity."
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
    "agentChains": {
      "fixer": ["openai/gpt-5.4-mini"],
      "librarian": ["openai/gpt-5.4-mini"]
    },
    "councilMaster": ["openai/gpt-5.4"]
  }
}
```

---

## Using `variant`

When both `model` and `variant` are set, Pantheon combines them into the effective model pattern used for agent runs.

Typical use:

```jsonc
{
  "agents": {
    "oracle": {
      "model": "anthropic/claude-sonnet-4-5",
      "variant": "high"
    }
  }
}
```

---

## Fast vs durable presets

Built-in top-level presets help with overall behavior:

- `default` — minimal extra config
- `fast` — lower-overhead council/research defaults
- `research` — stronger librarian/explorer bias
- `durable` — more conservative retry/debug defaults

Example:

```jsonc
{
  "extends": ["research", "durable"]
}
```

---

## Fallback chains

Use fallback chains when one model is ideal but you want graceful degradation.

```jsonc
{
  "fallback": {
    "agentChains": {
      "explorer": ["openai/gpt-5.4-mini"],
      "librarian": ["openai/gpt-5.4-mini"]
    },
    "councilMaster": ["openai/gpt-5.4"],
    "finalMessageGraceMs": 1500
  }
}
```

---

## Practical recommendations

- Give `oracle` your strongest reasoning model.
- Give `explorer` and `librarian` something fast and cheap enough for repeated reconnaissance.
- Give `designer` a model you trust for UI polish and broader synthesis.
- Keep council diverse when you want real second opinions; three copies of the same model rarely add much.
- If a provider is flaky, bias toward fallback chains and longer council timeouts.
- If a provider prints a final answer but lingers before exiting, tune `fallback.finalMessageGraceMs` instead of raising the full attempt timeout.

See also:

- [configuration.md](configuration.md)
- [council.md](council.md)
- [authors-preset.md](authors-preset.md)
