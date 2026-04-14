import type { AgentConfig } from "./agents.js";

export interface PantheonSpecialistGuide {
  categoryLabel: string;
  shortLabel: string;
  roleSummary: string;
  bestFor: string;
  avoidWhen: string;
  examplePrompts: string[];
  launcherDescription: string;
  pickerDescription: string;
  rationale: string;
  internal?: boolean;
}

const SPECIALIST_ORDER = ["explorer", "librarian", "oracle", "designer", "fixer", "council"] as const;
const INTERNAL_AGENT_ORDER = ["councillor", "council-master"] as const;

const SPECIALIST_GUIDES: Record<string, PantheonSpecialistGuide> = {
  explorer: {
    categoryLabel: "Investigate",
    shortLabel: "Recon specialist",
    roleSummary: "Fast codebase reconnaissance specialist",
    bestFor: "Finding files, entry points, configs, routes, and usage patterns before you edit.",
    avoidWhen: "You already know the exact file or the main work is implementation rather than discovery.",
    examplePrompts: [
      '"Find where auth routes are wired and which files own them."',
      '"Map the files involved in background task retries."',
    ],
    launcherDescription: "Reconnaissance before you open many files or implement a fix.",
    pickerDescription: "Investigate first: map files, wiring, and ownership before editing.",
    rationale: "reconnaissance is needed before implementation",
  },
  librarian: {
    categoryLabel: "Research",
    shortLabel: "Docs specialist",
    roleSummary: "Documentation and API research specialist",
    bestFor: "Checking official docs, package metadata, examples, release notes, and version-sensitive API behavior.",
    avoidWhen: "Repository evidence already answers the question or the task is pure implementation.",
    examplePrompts: [
      '"Check the package docs and confirm the supported API for this hook."',
      '"Find the changelog notes for this breaking change and summarize the migration guidance."',
    ],
    launcherDescription: "Docs and API research when library behavior matters.",
    pickerDescription: "Research docs and APIs when local repository evidence is not enough.",
    rationale: "library or API behavior needs documentation-backed research",
  },
  oracle: {
    categoryLabel: "Decide",
    shortLabel: "Strategy specialist",
    roleSummary: "Architecture, debugging, and review specialist",
    bestFor: "High-impact decisions, difficult debugging, design simplification, and correctness or risk review.",
    avoidWhen: "The task is routine, already well-scoped, and mostly typing code changes.",
    examplePrompts: [
      '"Review this refactor plan and point out the highest-risk failure modes."',
      '"Diagnose why this background workflow keeps failing after retries."',
    ],
    launcherDescription: "Architecture review, hard debugging, and high-stakes decisions.",
    pickerDescription: "Decide safely: use for architecture review, hard debugging, and risk checks.",
    rationale: "the task looks high-impact, ambiguous, or diagnosis-heavy",
  },
  designer: {
    categoryLabel: "Design",
    shortLabel: "UI specialist",
    roleSummary: "UI/UX implementation and polish specialist",
    bestFor: "User-facing layout, visual polish, interaction quality, spacing, responsiveness, and frontend ergonomics.",
    avoidWhen: "The task is backend-only or the main problem is architecture rather than user-facing quality.",
    examplePrompts: [
      '"Polish this settings panel so the hierarchy and spacing feel intentional."',
      '"Improve the empty states and responsive behavior for this dashboard view."',
    ],
    launcherDescription: "User-facing polish, interaction quality, and frontend ergonomics.",
    pickerDescription: "Design the user-facing result: polish layout, interaction, spacing, and feel.",
    rationale: "the request is user-facing and benefits from UI/UX polish",
  },
  fixer: {
    categoryLabel: "Implement",
    shortLabel: "Implementation specialist",
    roleSummary: "Fast bounded implementation specialist",
    bestFor: "Clear, implementation-heavy tasks once the files, bug, or plan are already known.",
    avoidWhen: "The task still needs broad investigation, external research, or architectural decision-making.",
    examplePrompts: [
      '"Apply this null-handling fix in src/foo.ts and add a regression test."',
      '"Implement the approved change and verify the touched paths."',
    ],
    launcherDescription: "Bounded implementation once requirements and direction are clear.",
    pickerDescription: "Implement once direction is clear and the remaining work is execution-heavy.",
    rationale: "requirements appear clear and the work is implementation-heavy",
  },
  council: {
    categoryLabel: "Consensus",
    shortLabel: "Consensus workflow",
    roleSummary: "Multi-model consensus and synthesis workflow",
    bestFor: "Ambiguous trade-offs, architecture choices, and decisions where one answer is not enough.",
    avoidWhen: "The task is routine, implementation-heavy, or a single strong specialist is sufficient.",
    examplePrompts: [
      '"Should we split this module now or wait until the migration lands?"',
      '"Evaluate the trade-offs between these two refactor paths."',
    ],
    launcherDescription: "High-confidence multi-model review for ambiguous decisions.",
    pickerDescription: "Ask for multiple perspectives when one specialist is not enough.",
    rationale: "the question benefits from multiple perspectives and synthesis",
  },
  councillor: {
    categoryLabel: "Council",
    shortLabel: "Council member",
    roleSummary: "Internal council member used during pantheon_council runs",
    bestFor: "Internal Pantheon use only.",
    avoidWhen: "You are choosing a specialist manually.",
    examplePrompts: [],
    launcherDescription: "Internal council helper.",
    pickerDescription: "Internal council helper.",
    rationale: "internal council member perspective",
    internal: true,
  },
  "council-master": {
    categoryLabel: "Council",
    shortLabel: "Council synthesis",
    roleSummary: "Internal synthesis step used during pantheon_council runs",
    bestFor: "Internal Pantheon use only.",
    avoidWhen: "You are choosing a specialist manually.",
    examplePrompts: [],
    launcherDescription: "Internal council helper.",
    pickerDescription: "Internal council helper.",
    rationale: "internal council synthesis step",
    internal: true,
  },
};

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function previewText(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function formatTools(agent: AgentConfig): string {
  if (agent.noTools) return "none";
  if (!agent.tools || agent.tools.length === 0) return "default builtins";
  return agent.tools.join(", ");
}

function renderAgentSection(agent: AgentConfig, guide: PantheonSpecialistGuide | undefined): string[] {
  const lines = [
    `${titleCase(agent.name)} [${agent.source}]`,
    guide ? `- Lane: ${guide.categoryLabel}` : undefined,
    `- Role: ${guide?.roleSummary ?? agent.description}`,
    guide ? `- Best for: ${guide.bestFor}` : undefined,
    guide ? `- Avoid when: ${guide.avoidWhen}` : undefined,
    `- Description: ${agent.description}`,
    agent.model ? `- Configured model: ${agent.model}` : undefined,
    `- Tools: ${formatTools(agent)}`,
  ].filter((line): line is string => Boolean(line));

  if (guide?.examplePrompts.length) {
    lines.push("- Example prompts:");
    for (const prompt of guide.examplePrompts) lines.push(`  - ${prompt}`);
  }

  return lines;
}

function getOrderedPublicGuides(agents: AgentConfig[]): Array<[AgentConfig, PantheonSpecialistGuide]> {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return SPECIALIST_ORDER
    .map((name) => {
      const agent = byName.get(name);
      const guide = SPECIALIST_GUIDES[name];
      return agent && guide ? [agent, guide] as const : undefined;
    })
    .filter((entry): entry is [AgentConfig, PantheonSpecialistGuide] => Boolean(entry));
}

export function getPantheonSpecialistGuide(name: string): PantheonSpecialistGuide | undefined {
  return SPECIALIST_GUIDES[name];
}

export function isInternalPantheonAgent(name: string): boolean {
  return Boolean(SPECIALIST_GUIDES[name]?.internal);
}

export function describePantheonSpecialist(name: string, fallbackDescription?: string): string {
  return SPECIALIST_GUIDES[name]?.launcherDescription ?? fallbackDescription ?? "Pantheon specialist";
}

export function buildPantheonSpecialistPickerLabel(name: string): string {
  const guide = SPECIALIST_GUIDES[name];
  if (!guide || guide.internal) return name;
  return `${guide.categoryLabel} · ${name}`;
}

export function buildPantheonSpecialistPickerDescription(name: string, fallbackDescription?: string): string {
  const guide = SPECIALIST_GUIDES[name];
  if (!guide) return fallbackDescription ?? "Pantheon specialist";
  if (guide.internal) return guide.pickerDescription;
  return previewText(`${guide.shortLabel} — ${guide.pickerDescription}`, 120);
}

export function buildPantheonDelegateRationale(agentName: string | undefined): string | undefined {
  if (!agentName) return undefined;
  return SPECIALIST_GUIDES[agentName]?.rationale;
}

export function buildPantheonActivityDescription(agentName: string | undefined, preview: string): string {
  if (!agentName) return preview;
  const guide = SPECIALIST_GUIDES[agentName];
  if (!guide) return preview;
  return `${guide.shortLabel} · ${preview}`;
}

export function buildPantheonSubagentInspectorLabel(label: string, agentName: string | undefined): string {
  const guide = agentName ? SPECIALIST_GUIDES[agentName] : undefined;
  if (!guide?.internal) return label;
  return `${label} · ${guide.shortLabel.toLowerCase()}`;
}

export function buildPantheonQuickHelpReport(agents: AgentConfig[]): string {
  const publicGuides = getOrderedPublicGuides(agents);
  const lines = [
    "Which specialist should I use?",
    "",
    "Use the specialist that matches the shape of the work:",
  ];

  for (const [agent, guide] of publicGuides) {
    lines.push(
      "",
      `${guide.categoryLabel} · ${agent.name}`,
      `- Use when: ${guide.bestFor}`,
      `- Avoid when: ${guide.avoidWhen}`,
      `- Quick prompt: ${guide.examplePrompts[0] ?? '"Describe the task clearly and keep it bounded."'}`,
    );
  }

  lines.push(
    "",
    "Shortcut:",
    "- Use /pantheon-as <specialist> <task> when you already know the right specialist.",
    "- Use /pantheon-agents when you want the fuller specialist guide.",
  );

  return lines.join("\n");
}

export function buildPantheonAgentsReport(agents: AgentConfig[], projectAgentsDir: string | null): string {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const publicAgents = SPECIALIST_ORDER
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentConfig => Boolean(agent));
  const internalAgents = INTERNAL_AGENT_ORDER
    .map((name) => byName.get(name))
    .filter((agent): agent is AgentConfig => Boolean(agent));
  const additionalAgents = agents.filter((agent) => !SPECIALIST_GUIDES[agent.name]);

  const lines = [
    "Pantheon specialist guide",
    "",
    "Use /pantheon when you want Pantheon to route the work, or /pantheon-as <specialist> <task> when you already know the right specialist.",
    "",
    "Core specialists:",
  ];

  for (const agent of publicAgents) {
    lines.push("");
    lines.push(...renderAgentSection(agent, SPECIALIST_GUIDES[agent.name]));
  }

  if (additionalAgents.length > 0) {
    lines.push("", "Additional available agents:");
    for (const agent of additionalAgents) {
      lines.push("");
      lines.push(...renderAgentSection(agent, undefined));
      lines.push("- Notes: No built-in Pantheon guidance is available for this custom agent.");
    }
  }

  if (internalAgents.length > 0) {
    lines.push("", "Internal council helpers:");
    for (const agent of internalAgents) {
      const guide = SPECIALIST_GUIDES[agent.name];
      lines.push(`- ${agent.name} [${agent.source}] — ${guide?.roleSummary ?? agent.description}`);
    }
  }

  if (projectAgentsDir) {
    lines.push("", `Project override directory: ${projectAgentsDir}`);
  }

  return lines.join("\n");
}
