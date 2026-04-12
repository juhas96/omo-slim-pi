import * as fs from "node:fs";
import * as path from "node:path";

export interface BootstrapResult {
  rootDir: string;
  files: string[];
}

export function buildBootstrapConfig(): string {
  return `{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["durable"],
  "skills": {
    "defaultAllow": ["cartography"],
    "cartography": {
      "enabled": true,
      "maxFiles": 250,
      "maxDepth": 4
    }
  },
  "agents": {
    "explorer": {
      "allowSkills": ["cartography"],
      "allowedAdapters": ["local-docs", "docs-context7", "github-code-search", "web-search"]
    },
    "librarian": {
      "allowedAdapters": ["local-docs", "docs-context7", "github-releases", "github-code-search", "web-search"]
    }
  }
}
`;
}

export function bootstrapPantheonProject(cwd: string, options?: { force?: boolean }): BootstrapResult {
  const rootDir = path.join(cwd, ".pi");
  const files: string[] = [];
  fs.mkdirSync(rootDir, { recursive: true });

  const entries: Array<{ relativePath: string; content: string }> = [
    { relativePath: "oh-my-opencode-pi.jsonc", content: buildBootstrapConfig() },
    { relativePath: path.join("pantheon-adapters", "README.md"), content: "# Pantheon adapters\n\nDrop custom adapter modules (`.mjs`, `.js`, `.cjs`) in this directory to auto-load them.\n" },
    { relativePath: path.join("agents", "README.md"), content: "# Pantheon agents\n\nOverride or add project-local specialist agents here.\n" },
    { relativePath: path.join("prompts", "README.md"), content: "# Pantheon prompts\n\nStore project-specific prompt append/override files here.\n" },
  ];

  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.relativePath);
    if (!options?.force && fs.existsSync(filePath)) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, entry.content);
    files.push(filePath);
  }

  return { rootDir, files };
}

export function buildBootstrapGuide(cwd: string, createdFiles: string[]): string {
  return [
    "# Pantheon bootstrap complete",
    "",
    `Project: ${cwd}`,
    createdFiles.length > 0 ? `Created files:\n${createdFiles.map((file) => `- ${file}`).join("\n")}` : "Created files:\n- (none; existing files kept)",
    "",
    "## Next steps",
    "1. Review .pi/oh-my-opencode-pi.jsonc",
    "2. Run /pantheon-config to inspect active presets and warnings",
    "3. Try /pantheon, /pantheon-repo-map, and /pantheon-code-map",
    "4. Add project adapters under .pi/pantheon-adapters/ if needed",
    "",
    "## Helpful commands",
    "- /pantheon-bootstrap",
    "- /pantheon-skills",
    "- /pantheon-config",
    "- /pantheon-spec-studio",
  ].join("\n");
}

export function buildSpecStudioTemplate(kind: string, title: string): string {
  const normalizedKind = kind.trim().toLowerCase();
  const common = [
    `# ${title}`,
    "",
    `Kind: ${normalizedKind}`,
    "",
    "## Objective",
    "Describe the user or engineering outcome.",
    "",
    "## Scope",
    "What is included and excluded?",
    "",
    "## Constraints",
    "Technical, product, timeline, or risk constraints.",
    "",
    "## Success Criteria",
    "How will we know this worked?",
    "",
  ];

  const specialized = normalizedKind === "refactor"
    ? [
        "## Current Pain",
        "What is hard to change or risky today?",
        "",
        "## Migration Plan",
        "Phased rollout, compatibility, and verification steps.",
      ]
    : normalizedKind === "investigation"
      ? [
          "## Questions to Answer",
          "List the unknowns this investigation must resolve.",
          "",
          "## Evidence / Sources",
          "What code, docs, or systems should be inspected?",
        ]
      : normalizedKind === "incident"
        ? [
            "## Impact",
            "Who or what is affected?",
            "",
            "## Reproduction / Timeline",
            "Known reproduction steps or observed timeline.",
            "",
            "## Remediation",
            "Immediate fix, follow-up hardening, and verification.",
          ]
        : [
            "## User Stories",
            "- As a ... I want ... so that ...",
            "",
            "## UX / Interaction Notes",
            "Key states, edge cases, and accessibility concerns.",
          ];

  return [...common, ...specialized, "", "## Open Questions", "Outstanding trade-offs or decisions."].join("\n");
}
