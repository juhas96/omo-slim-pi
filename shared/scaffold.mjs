export function buildPantheonScaffoldConfig({ tmuxEnabled = false, skillsEnabled = true } = {}) {
  return `{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["durable"],
  // Pantheon inherits pi's default provider/model unless you add explicit overrides below.
  // If you do add them, make sure the provider prefix matches your pi auth setup
  // (for example openai-codex/... for ChatGPT subscription auth vs openai/... for API keys).
  "multiplexer": {
    "tmux": ${tmuxEnabled ? "true" : "false"},
    "layout": "main-vertical",
    "focusOnSpawn": false
  },
  "agents": {
    "explorer": {
      "allowSkills": ${skillsEnabled ? '["cartography"]' : '[]'},
      "allowedAdapters": ["local-docs", "docs-context7", "github-code-search", "web-search"]
    },
    "librarian": {
      "allowedAdapters": ["local-docs", "docs-context7", "github-releases", "github-code-search", "web-search", "npm-registry"]
    }
  },
  "council": {
    "defaultPreset": "review-board"
  },
  "skills": {
    "defaultAllow": ${skillsEnabled ? '["karpathy-guidelines", "cartography"]' : '[]'},
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
