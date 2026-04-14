export function buildPantheonScaffoldConfig({ tmuxEnabled = false, skillsEnabled = true } = {}) {
  return `{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["durable"],
  // The top-level pi session model stays whatever you selected in pi.
  // These overrides control delegated Pantheon specialists and council runs.
  "multiplexer": {
    "tmux": ${tmuxEnabled ? "true" : "false"},
    "layout": "main-vertical",
    "focusOnSpawn": false
  },
  "agents": {
    "oracle": {
      "model": "openai/gpt-5.4",
      "variant": "high"
    },
    "explorer": {
      "model": "openai/gpt-5.4-mini",
      "variant": "low",
      "allowSkills": ${skillsEnabled ? '["cartography"]' : '[]'},
      "allowedAdapters": ["local-docs", "docs-context7", "github-code-search", "web-search"]
    },
    "librarian": {
      "model": "openai/gpt-5.4-mini",
      "variant": "low",
      "allowedAdapters": ["local-docs", "docs-context7", "github-releases", "github-code-search", "web-search", "npm-registry"]
    },
    "designer": {
      "model": "openai/gpt-5.4-mini",
      "variant": "medium"
    },
    "fixer": {
      "model": "openai/gpt-5.4-mini",
      "variant": "low"
    }
  },
  "council": {
    "defaultPreset": "review-board",
    "presets": {
      "review-board": {
        "master": {
          "model": "openai/gpt-5.4",
          "variant": "high",
          "prompt": "Prioritize correctness, maintainability, and operational simplicity."
        },
        "councillors": [
          { "name": "reviewer", "model": "openai/gpt-5.4" },
          { "name": "architect", "model": "openai/gpt-5.4-mini", "variant": "medium" },
          { "name": "skeptic", "model": "openai/gpt-5.4-mini", "variant": "medium" }
        ]
      }
    }
  },
  "skills": {
    "defaultAllow": ${skillsEnabled ? '["cartography"]' : '[]'},
    "cartography": {
      "enabled": ${skillsEnabled ? "true" : "false"},
      "maxFiles": 250,
      "maxDepth": 4,
      "maxPerDirectory": 8
    }
  }
}
`;
}

export function getPantheonScaffoldEntries({ tmuxEnabled = false, skillsEnabled = true } = {}) {
  return [
    { relativePath: "oh-my-opencode-pi.jsonc", content: buildPantheonScaffoldConfig({ tmuxEnabled, skillsEnabled }) },
    { relativePath: "pantheon-adapters/README.md", content: "# Pantheon adapters\n\nDrop custom adapter modules (`.mjs`, `.js`, `.cjs`) in this directory to auto-load them.\n" },
    { relativePath: "agents/README.md", content: "# Pantheon agents\n\nOverride or add project-local specialist agents here.\n" },
    { relativePath: "prompts/README.md", content: "# Pantheon prompts\n\nStore project-specific prompt append/override files here.\n" },
  ];
}

export function getPantheonScaffoldRequiredPaths() {
  return getPantheonScaffoldEntries().map((entry) => entry.relativePath);
}
