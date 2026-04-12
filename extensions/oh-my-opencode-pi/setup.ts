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
  // The top-level pi session model stays whatever you selected in pi.
  // These overrides control delegated Pantheon specialists and council runs.
  "agents": {
    "oracle": {
      "model": "openai/gpt-4.1",
      "variant": "high"
    },
    "explorer": {
      "model": "openai/gpt-4.1-mini",
      "variant": "low",
      "allowSkills": ["cartography"],
      "allowedAdapters": ["local-docs", "docs-context7", "github-code-search", "web-search"]
    },
    "librarian": {
      "model": "openai/gpt-4.1-mini",
      "variant": "low",
      "allowedAdapters": ["local-docs", "docs-context7", "github-releases", "github-code-search", "web-search", "npm-registry"]
    },
    "designer": {
      "model": "openai/gpt-4.1-mini",
      "variant": "medium"
    },
    "fixer": {
      "model": "openai/gpt-4.1-mini",
      "variant": "low"
    }
  },
  "council": {
    "defaultPreset": "review-board",
    "presets": {
      "review-board": {
        "master": {
          "model": "openai/gpt-4.1",
          "variant": "high",
          "prompt": "Prioritize correctness, maintainability, and operational simplicity."
        },
        "councillors": [
          { "name": "reviewer", "model": "openai/gpt-4.1" },
          { "name": "architect", "model": "openai/gpt-4.1-mini", "variant": "medium" },
          { "name": "skeptic", "model": "openai/gpt-4.1-mini", "variant": "medium" }
        ]
      }
    }
  },
  "skills": {
    "defaultAllow": ["cartography"],
    "cartography": {
      "enabled": true,
      "maxFiles": 250,
      "maxDepth": 4
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
    "3. Try /pantheon and the bundled cartography skill (/skill:cartography when skill commands are enabled)",
    "4. Add project adapters under .pi/pantheon-adapters/ if needed",
    "",
    "## Helpful commands",
    "- /pantheon-bootstrap",
    "- /pantheon-skills",
    "- /pantheon-config",
    "- /skill:cartography",
    "- /pantheon-spec-studio",
  ].join("\n");
}

function buildCommonExecutionSections(): string[] {
  return [
    "## Assumptions",
    "State assumptions that should be validated early.",
    "",
    "## Execution Plan",
    "1. Recon / current-state mapping",
    "2. Proposed change design",
    "3. Implementation slices",
    "4. Verification and rollout",
    "",
    "## Validation Plan",
    "What tests, diagnostics, benchmarks, screenshots, or manual checks will prove this worked?",
    "",
    "## Risks / Trade-offs",
    "Known risks, failure modes, and explicit trade-offs.",
    "",
    "## Rollout / Recovery",
    "Deployment, migration, rollback, and observability notes.",
    "",
    "## Decision Log",
    "- Decision:\n  - Why:\n  - Owner:\n",
  ];
}

export function buildSpecStudioTemplate(kind: string, title: string, options?: { context?: string; focusAreas?: string }): string {
  const normalizedKind = kind.trim().toLowerCase();
  const common = [
    `# ${title}`,
    "",
    `Kind: ${normalizedKind}`,
    options?.context?.trim() ? `Context: ${options.context.trim()}` : "Context: (add current repo/product/system context)",
    options?.focusAreas?.trim() ? `Focus areas: ${options.focusAreas.trim()}` : "Focus areas: (optional; call out the highest-leverage concerns)",
    "",
    "## Objective",
    "Describe the user or engineering outcome.",
    "",
    "## Problem Framing",
    "What pain, opportunity, or risk makes this work necessary now?",
    "",
    "## Scope",
    "What is included and excluded?",
    "",
    "## Constraints",
    "Technical, product, timeline, or risk constraints.",
    "",
    "## Success Criteria",
    "How will we know this worked? Include measurable verification where possible.",
    "",
  ];

  const specialized = normalizedKind === "refactor"
    ? [
        "## Current Pain",
        "What is hard to change, risky, duplicated, or slow today?",
        "",
        "## Target Architecture",
        "Describe the intended boundaries, ownership, and simplifications.",
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
          "What code, docs, logs, or systems should be inspected?",
          "",
          "## Exit Criteria",
          "What evidence is required before this investigation can be considered complete?",
        ]
      : normalizedKind === "incident"
        ? [
            "## Impact",
            "Who or what is affected? Include severity and user/system symptoms.",
            "",
            "## Reproduction / Timeline",
            "Known reproduction steps or observed timeline.",
            "",
            "## Containment",
            "Immediate mitigations to reduce blast radius.",
            "",
            "## Remediation",
            "Immediate fix, follow-up hardening, and verification.",
          ]
        : [
            "## User Stories",
            "- As a ... I want ... so that ...",
            "",
            "## UX / Interaction Notes",
            "Key states, edge cases, accessibility concerns, and copy considerations.",
            "",
            "## Deliverables",
            "List the concrete artifacts expected from this work.",
          ];

  return [...common, ...specialized, "", ...buildCommonExecutionSections(), "## Open Questions", "Outstanding trade-offs, dependencies, or decisions."].join("\n");
}
