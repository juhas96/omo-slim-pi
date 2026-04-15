import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { PantheonConfig } from "./config.js";

export interface PantheonConfiguredModelProvider {
  path: string;
  model: string;
  provider: string;
}

export interface PantheonProviderAudit {
  settingsPath: string;
  authPath: string;
  defaultProvider?: string;
  authenticatedProviders: string[];
  explicitModels: PantheonConfiguredModelProvider[];
  warnings: string[];
}

const PROVIDER_ENV_MAP: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
};

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function extractProvider(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || !trimmed.includes("/")) return undefined;
  const [provider] = trimmed.split("/", 1);
  return provider?.trim() || undefined;
}

function addModelEntry(entries: PantheonConfiguredModelProvider[], entryPath: string, model: string | undefined): void {
  const trimmed = model?.trim();
  const provider = extractProvider(trimmed);
  if (!trimmed || !provider) return;
  entries.push({ path: entryPath, model: trimmed, provider });
}

export function collectConfiguredModelProviders(config: PantheonConfig): PantheonConfiguredModelProvider[] {
  const entries: PantheonConfiguredModelProvider[] = [];

  for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
    addModelEntry(entries, `agents.${agentName}.model`, agent.model);
  }

  for (const [presetName, preset] of Object.entries(config.council?.presets ?? {})) {
    addModelEntry(entries, `council.presets.${presetName}.master.model`, preset.master?.model);
    preset.councillors.forEach((member, index) => {
      addModelEntry(entries, `council.presets.${presetName}.councillors[${index}].model`, member.model);
    });
  }

  for (const [agentName, chain] of Object.entries(config.fallback?.agentChains ?? {})) {
    chain.forEach((model, index) => addModelEntry(entries, `fallback.agentChains.${agentName}[${index}]`, model));
  }

  (config.fallback?.councilMaster ?? []).forEach((model, index) => {
    addModelEntry(entries, `fallback.councilMaster[${index}]`, model);
  });

  return entries;
}

export function listAuthenticatedProviders(agentDir = getAgentDir()): { settingsPath: string; authPath: string; defaultProvider?: string; authenticatedProviders: string[] } {
  const settingsPath = path.join(agentDir, "settings.json");
  const authPath = path.join(agentDir, "auth.json");
  const settings = readJsonObject(settingsPath);
  const auth = readJsonObject(authPath);
  const defaultProvider = typeof settings?.defaultProvider === "string" ? settings.defaultProvider.trim() || undefined : undefined;

  const providers = new Set<string>();
  if (defaultProvider) providers.add(defaultProvider);

  for (const provider of Object.keys(auth ?? {})) {
    if (provider.trim()) providers.add(provider.trim());
  }

  for (const [provider, envNames] of Object.entries(PROVIDER_ENV_MAP)) {
    if (envNames.some((envName) => Boolean(process.env[envName]?.trim()))) {
      providers.add(provider);
    }
  }

  return {
    settingsPath,
    authPath,
    defaultProvider,
    authenticatedProviders: [...providers].sort(),
  };
}

export function auditPantheonProviderConfiguration(config: PantheonConfig, agentDir = getAgentDir()): PantheonProviderAudit {
  const explicitModels = collectConfiguredModelProviders(config);
  const authContext = listAuthenticatedProviders(agentDir);
  const warnings: string[] = [];
  const authenticated = new Set(authContext.authenticatedProviders);

  if (explicitModels.length > 0) {
    const mismatched = explicitModels.filter((entry) => !authenticated.has(entry.provider));
    if (mismatched.length > 0) {
      const missingProviders = [...new Set(mismatched.map((entry) => entry.provider))];
      const availableProviders = authContext.authenticatedProviders.length > 0 ? authContext.authenticatedProviders.join(", ") : "(none detected)";
      if (authContext.defaultProvider && missingProviders.length === 1) {
        warnings.push(`Configured Pantheon models reference provider '${missingProviders[0]}', but pi default/authenticated provider is '${authContext.defaultProvider}' and no auth was detected for '${missingProviders[0]}'.`);
      } else {
        warnings.push(`Configured Pantheon models reference provider(s) ${missingProviders.map((provider) => `'${provider}'`).join(", ")}, but auth was only detected for: ${availableProviders}.`);
      }
      const affected = mismatched.map((entry) => `${entry.path}=${entry.model}`);
      warnings.push(`Affected entries: ${affected.slice(0, 6).join("; ")}${affected.length > 6 ? `; +${affected.length - 6} more` : ""}`);
      warnings.push("Fix: switch the provider prefix to one pi is authenticated for, or remove explicit Pantheon model overrides so delegated runs inherit pi defaults.");
    }
  }

  return {
    ...authContext,
    explicitModels,
    warnings,
  };
}
