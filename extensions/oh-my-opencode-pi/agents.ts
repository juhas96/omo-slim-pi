import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import {
  findNearestProjectPath,
  loadPantheonConfig,
  resolveAgentAdapterPolicy,
  resolveAgentSkillPolicy,
  resolveConfiguredAgentModel,
  resolveConfiguredAgentOverride,
} from "./config.js";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  noTools?: boolean;
  model?: string;
  options?: string[];
  systemPrompt: string;
  source: "bundled" | "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!isDirectory(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const rawTools = frontmatter.tools?.trim();
    const noTools = rawTools === "none";
    const tools = !rawTools || noTools
      ? undefined
      : rawTools
          .split(",")
          .map((tool: string) => tool.trim())
          .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      noTools,
      model: frontmatter.model?.trim() || undefined,
      options: undefined,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

function readPromptFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return undefined;
  }
}

function renderPolicyPrompt(cwd: string, agentName: string): string | undefined {
  const config = loadPantheonConfig(cwd).config;
  const skillPolicy = resolveAgentSkillPolicy(config, agentName);
  const adapterPolicy = resolveAgentAdapterPolicy(config, agentName);
  const lines: string[] = [];
  const deniedSkills = new Set(skillPolicy.deny);
  const hasSkillAllowlist = skillPolicy.allow.length > 0;
  const allowedSkills = hasSkillAllowlist
    ? skillPolicy.allow.filter((skill) => !deniedSkills.has(skill))
    : [];
  const isSkillAllowed = (skill: string): boolean => {
    if (deniedSkills.has(skill)) return false;
    return !hasSkillAllowlist || allowedSkills.includes(skill);
  };

  if (allowedSkills.length > 0) lines.push(`Allowed skills: ${allowedSkills.join(", ")}.`);
  if (skillPolicy.deny.length > 0) lines.push(`Disallowed skills: ${skillPolicy.deny.join(", ")}.`);
  if (isSkillAllowed("karpathy-guidelines")) {
    lines.push("Prefer the bundled karpathy-guidelines skill for non-trivial implementation, review, and refactor work: surface assumptions, choose the simplest solution that fits, keep diffs surgical, and define concrete verification before claiming success.");
  }
  if (skillPolicy.cartographyEnabled && isSkillAllowed("cartography")) {
    lines.push("Prefer the bundled cartography skill for repository mapping and codemap maintenance. When doing cartography work, use pantheon_repo_map for filesystem reconnaissance and pantheon_code_map for semantic import/symbol mapping.");
  }

  if (adapterPolicy.disableAll) {
    lines.push("External research adapters are globally disabled in config.");
  } else {
    if (adapterPolicy.allow.length > 0) lines.push(`Allowed research adapters: ${adapterPolicy.allow.join(", ")}.`);
    if (adapterPolicy.deny.length > 0 || adapterPolicy.disabled.length > 0) {
      lines.push(`Disallowed research adapters: ${[...new Set([...adapterPolicy.deny, ...adapterPolicy.disabled])].join(", ")}.`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function applyAgentOverride(baseAgent: AgentConfig, cwd: string): AgentConfig | undefined {
  const config = loadPantheonConfig(cwd).config;
  const override = resolveConfiguredAgentOverride(config, baseAgent.name);
  if (override?.disabled) return undefined;

  const overridePrompt = override?.promptOverrideFile ? readPromptFile(override.promptOverrideFile) : undefined;
  const appendPromptParts = [
    override?.promptAppendText?.trim(),
    ...(override?.promptAppendFiles ?? []).map((filePath) => readPromptFile(filePath)),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  const systemPrompt = [
    overridePrompt ?? baseAgent.systemPrompt,
    ...appendPromptParts,
    renderPolicyPrompt(cwd, baseAgent.name),
  ].filter(Boolean).join("\n\n");

  const noTools = override?.noTools ?? baseAgent.noTools;
  const tools = noTools
    ? undefined
    : override?.tools && override.tools.length > 0
      ? [...override.tools]
      : baseAgent.tools;

  return {
    ...baseAgent,
    model: resolveConfiguredAgentModel(override?.model ?? baseAgent.model, override?.variant),
    options: override?.options ?? baseAgent.options,
    noTools,
    tools,
    systemPrompt,
  };
}

export function getBundledAgentsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents");
}

export function loadOrchestratorPrompt(): string {
  const filePath = path.join(getBundledAgentsDir(), "orchestrator.md");
  return fs.readFileSync(filePath, "utf8").trim();
}

export function discoverPantheonAgents(cwd: string, includeProjectAgents = false): AgentDiscoveryResult {
  const bundledDir = getBundledAgentsDir();
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectPath(cwd, path.join(".pi", "agents"));

  const bundledAgents = loadAgentsFromDir(bundledDir, "bundled");
  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = includeProjectAgents && projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, "project")
    : [];

  const agentMap = new Map<string, AgentConfig>();
  for (const agent of bundledAgents) agentMap.set(agent.name, agent);
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  const agents = [...agentMap.values()]
    .map((agent) => applyAgentOverride(agent, cwd))
    .filter((agent): agent is AgentConfig => Boolean(agent));

  return {
    agents,
    projectAgentsDir: projectAgentsDir && includeProjectAgents ? projectAgentsDir : null,
  };
}
