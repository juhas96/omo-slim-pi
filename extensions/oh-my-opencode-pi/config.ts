import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse } from "jsonc-parser";

export interface CouncilMemberConfig {
  name: string;
  model?: string;
  prompt?: string;
  options?: string[];
}

export interface CouncilPresetConfig {
  master?: {
    model?: string;
    prompt?: string;
    options?: string[];
  };
  councillors: CouncilMemberConfig[];
}

export interface AgentOverrideConfig {
  model?: string;
  variant?: string;
  options?: string[];
  tools?: string[];
  noTools?: boolean;
  promptOverrideFile?: string;
  promptAppendFiles?: string[];
  promptAppendText?: string;
  allowSkills?: string[];
  denySkills?: string[];
  allowedAdapters?: string[];
  deniedAdapters?: string[];
  disabled?: boolean;
}

export interface PantheonConfig {
  appendOrchestratorPrompt?: boolean;
  agents?: Record<string, AgentOverrideConfig>;
  council?: {
    defaultPreset?: string;
    presets?: Record<string, CouncilPresetConfig>;
    masterTimeoutMs?: number;
    councillorsTimeoutMs?: number;
  };
  fallback?: {
    timeoutMs?: number;
    delegateTimeoutMs?: number;
    retryDelayMs?: number;
    retryOnEmpty?: boolean;
    agentTimeouts?: Record<string, number>;
    agentChains?: Record<string, string[]>;
    councilMaster?: string[];
  };
  background?: {
    enabled?: boolean;
    pollIntervalMs?: number;
    logDir?: string;
    maxConcurrent?: number;
  };
  multiplexer?: {
    tmux?: boolean;
    splitDirection?: "vertical" | "horizontal";
    layout?: "tiled" | "even-horizontal" | "even-vertical" | "main-horizontal" | "main-vertical";
    focusOnSpawn?: boolean;
    keepPaneOnFinish?: boolean;
    reuseWindow?: boolean;
    windowName?: string;
  };
  research?: {
    timeoutMs?: number;
    userAgent?: string;
    maxResults?: number;
    githubToken?: string;
    defaultDocsSite?: string;
  };
  skills?: {
    setupHints?: boolean;
    defaultAllow?: string[];
    defaultDeny?: string[];
    cartography?: {
      enabled?: boolean;
      maxFiles?: number;
      maxDepth?: number;
      maxPerDirectory?: number;
      exclude?: string[];
    };
  };
  adapters?: {
    disableAll?: boolean;
    disabled?: string[];
    defaultAllow?: string[];
    defaultDeny?: string[];
    modules?: string[];
  };
  delegation?: {
    maxDepth?: number;
  };
  autoContinue?: {
    enabled?: boolean;
    cooldownMs?: number;
    maxContinuations?: number;
    autoEnable?: boolean;
    autoEnableThreshold?: number;
  };
  interview?: {
    templateTitle?: string;
  };
  workflow?: {
    injectHints?: boolean;
    backgroundAwareness?: boolean;
    todoThreshold?: number;
    persistTodos?: boolean;
    stateFile?: string;
    phaseReminders?: boolean;
    postFileToolNudges?: boolean;
    delegateRetryGuidance?: boolean;
  };
  ui?: {
    dashboardWidget?: boolean;
    maxTodos?: number;
    maxBackgroundTasks?: number;
  };
  debug?: {
    enabled?: boolean;
    logDir?: string;
  };
}

export interface PantheonConfigLoadResult {
  config: PantheonConfig;
  warnings: string[];
  sources: {
    globalPath: string;
    projectPath: string | null;
  };
  activePresets: string[];
  availablePresets: string[];
}

type RawObject = Record<string, unknown>;

const DEFAULT_COUNCIL_PRESET: CouncilPresetConfig = {
  councillors: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
};

const DEFAULT_COUNCIL_PRESETS: Record<string, CouncilPresetConfig> = {
  default: {
    councillors: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
  },
  quick: {
    councillors: [{ name: "reviewer" }],
  },
  balanced: {
    councillors: [{ name: "alpha" }, { name: "beta" }],
  },
  "review-board": {
    master: {
      prompt: "Prioritize correctness, maintainability, and operational simplicity.",
    },
    councillors: [
      { name: "reviewer", prompt: "Focus on bugs, correctness, and edge cases." },
      { name: "architect", prompt: "Focus on architecture, coupling, and maintainability." },
      { name: "skeptic", prompt: "Challenge assumptions and propose simpler alternatives." },
    ],
  },
};

const DEFAULT_CONFIG_PRESETS: Record<string, RawObject> = {
  default: {},
  fast: {
    council: { defaultPreset: "quick" },
    research: { maxResults: 3 },
    background: { maxConcurrent: 1 },
  },
  research: {
    council: { defaultPreset: "balanced" },
    research: { maxResults: 8 },
    fallback: {
      agentTimeouts: {
        librarian: 180000,
        explorer: 120000,
      },
    },
  },
  durable: {
    fallback: {
      retryOnEmpty: true,
      retryDelayMs: 750,
    },
    debug: { enabled: true },
  },
};

function clonePreset(preset: CouncilPresetConfig): CouncilPresetConfig {
  return {
    master: preset.master ? { ...preset.master, options: preset.master.options ? [...preset.master.options] : undefined } : undefined,
    councillors: preset.councillors.map((member) => ({ ...member, options: member.options ? [...member.options] : undefined })),
  };
}

function clonePresetMap(presets: Record<string, CouncilPresetConfig>): Record<string, CouncilPresetConfig> {
  return Object.fromEntries(Object.entries(presets).map(([name, preset]) => [name, clonePreset(preset)]));
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function findNearestProjectPath(cwd: string, relativePath: string | string[]): string | null {
  const candidates = Array.isArray(relativePath) ? relativePath : [relativePath];
  let currentDir = cwd;
  while (true) {
    for (const relative of candidates) {
      const candidate = path.join(currentDir, relative);
      if (existsFile(candidate) || isDirectory(candidate)) return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function findFirstExistingPath(paths: string[]): string | null {
  return paths.find((candidate) => existsFile(candidate) || isDirectory(candidate)) ?? null;
}

function isObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(isNonEmptyString).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildModelPattern(model: string | undefined, variant: string | undefined): string | undefined {
  const base = model?.trim();
  const resolvedVariant = variant?.trim();
  if (!base) return undefined;
  if (!resolvedVariant) return base;
  return base.includes(":") ? base : `${base}:${resolvedVariant}`;
}

function cloneUnknown<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneUnknown(item)) as T;
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneUnknown(child)])) as T;
  }
  return value;
}

function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return cloneUnknown(base);
  if (Array.isArray(base) && Array.isArray(override)) return cloneUnknown(override) as T;
  if (isObject(base) && isObject(override)) {
    const merged: RawObject = { ...cloneUnknown(base as RawObject) };
    for (const [key, value] of Object.entries(override)) {
      if (!(key in merged)) {
        merged[key] = cloneUnknown(value);
        continue;
      }
      merged[key] = deepMerge(merged[key], value);
    }
    return merged as T;
  }
  return cloneUnknown(override as T);
}

function stripInternalConfigKeys(input: RawObject): RawObject {
  const clone = cloneUnknown(input);
  delete clone.preset;
  delete clone.extends;
  delete clone.presets;
  return clone;
}

function normalizeConfigPaths(value: unknown, baseDir: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeConfigPaths(item, baseDir));
  if (!isObject(value)) return value;
  const result: RawObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "promptOverrideFile" && isNonEmptyString(child)) {
      result[key] = path.isAbsolute(child) ? child : path.resolve(baseDir, child);
      continue;
    }
    if (key === "promptAppendFiles" && Array.isArray(child)) {
      result[key] = child.filter(isNonEmptyString).map((item) => path.isAbsolute(item) ? item : path.resolve(baseDir, item));
      continue;
    }
    if (key === "modules" && Array.isArray(child)) {
      result[key] = child.filter(isNonEmptyString).map((item) => path.isAbsolute(item) ? item : path.resolve(baseDir, item));
      continue;
    }
    result[key] = normalizeConfigPaths(child, baseDir);
  }
  return result;
}

function loadJsoncFile(filePath: string, warnings: string[]): RawObject {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const errors: Array<{ error: number; offset: number; length: number }> = [];
    const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      warnings.push(`Config parse warning in ${filePath}: ${errors.length} JSONC parse issue${errors.length === 1 ? "" : "s"} detected.`);
    }
    return isObject(parsed) ? normalizeConfigPaths(parsed, path.dirname(filePath)) as RawObject : {};
  } catch (error) {
    warnings.push(`Unable to read config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function getPresetRefs(raw: RawObject): string[] {
  const refs: string[] = [];
  if (isNonEmptyString(raw.preset)) refs.push(raw.preset.trim());
  if (Array.isArray(raw.extends)) {
    refs.push(...raw.extends.filter(isNonEmptyString).map((item) => item.trim()));
  }
  return refs.filter((item, index, array) => array.indexOf(item) === index);
}

function resolvePresetConfig(name: string, presets: Record<string, RawObject>, warnings: string[], stack: string[] = []): RawObject {
  const preset = presets[name];
  if (!preset) {
    warnings.push(`Unknown config preset '${name}' ignored.`);
    return {};
  }
  if (stack.includes(name)) {
    warnings.push(`Circular config preset reference detected: ${[...stack, name].join(" -> ")}`);
    return {};
  }

  let resolved: RawObject = {};
  for (const ref of getPresetRefs(preset)) {
    resolved = deepMerge(resolved, resolvePresetConfig(ref, presets, warnings, [...stack, name]));
  }
  return deepMerge(resolved, stripInternalConfigKeys(preset));
}

function resolveConfigWithPresets(raw: RawObject, presets: Record<string, RawObject>, warnings: string[]): { config: RawObject; activePresets: string[] } {
  let resolved: RawObject = {};
  const activePresets = getPresetRefs(raw);
  for (const presetName of activePresets) {
    resolved = deepMerge(resolved, resolvePresetConfig(presetName, presets, warnings));
  }
  resolved = deepMerge(resolved, stripInternalConfigKeys(raw));
  return { config: resolved, activePresets };
}

function toRawPresetMap(value: unknown): Record<string, RawObject> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, preset]) => isObject(preset))
      .map(([name, preset]) => [name, preset as RawObject]),
  );
}

function sanitizeCouncilMember(value: unknown, key: string, warnings: string[]): CouncilMemberConfig | undefined {
  if (!isObject(value)) {
    warnings.push(`Council member '${key}' ignored: expected object.`);
    return undefined;
  }

  const name = isNonEmptyString(value.name) ? value.name.trim() : key;
  const model = buildModelPattern(
    isNonEmptyString(value.model) ? value.model.trim() : undefined,
    isNonEmptyString(value.variant) ? value.variant.trim() : undefined,
  );
  const prompt = isNonEmptyString(value.prompt) ? value.prompt : undefined;
  const options = sanitizeStringArray(value.options);
  return { name, model, prompt, options };
}

function sanitizeCouncilPreset(value: unknown, presetName: string, warnings: string[]): CouncilPresetConfig | undefined {
  if (!isObject(value)) {
    warnings.push(`Council preset '${presetName}' ignored: expected object.`);
    return undefined;
  }

  let master: CouncilPresetConfig["master"] | undefined;
  if (value.master !== undefined) {
    if (!isObject(value.master)) {
      warnings.push(`Council preset '${presetName}'.master ignored: expected object.`);
    } else {
      master = {
        model: buildModelPattern(
          isNonEmptyString(value.master.model) ? value.master.model.trim() : undefined,
          isNonEmptyString(value.master.variant) ? value.master.variant.trim() : undefined,
        ),
        prompt: isNonEmptyString(value.master.prompt) ? value.master.prompt : undefined,
        options: sanitizeStringArray(value.master.options),
      };
    }
  }

  let councillors: CouncilMemberConfig[] = [];
  if (Array.isArray(value.councillors)) {
    councillors = value.councillors
      .map((entry, index) => sanitizeCouncilMember(entry, `${presetName}[${index}]`, warnings))
      .filter((member): member is CouncilMemberConfig => Boolean(member));
  } else if (isObject(value.councillors)) {
    councillors = Object.entries(value.councillors)
      .map(([key, entry]) => sanitizeCouncilMember(entry, key, warnings))
      .filter((member): member is CouncilMemberConfig => Boolean(member));
  }

  if (councillors.length === 0) {
    warnings.push(`Council preset '${presetName}' has no valid councillors; using defaults.`);
    councillors = DEFAULT_COUNCIL_PRESET.councillors.map((member) => ({ ...member }));
  }

  return { master, councillors };
}

function sanitizeAgentOverride(value: unknown, agentName: string, warnings: string[]): AgentOverrideConfig | undefined {
  if (!isObject(value)) {
    warnings.push(`Agent override '${agentName}' ignored: expected object.`);
    return undefined;
  }

  const promptOverrideFile = isNonEmptyString(value.promptOverrideFile) ? value.promptOverrideFile.trim() : undefined;
  const promptAppendFiles = sanitizeStringArray(value.promptAppendFiles);
  if (promptOverrideFile && !existsFile(promptOverrideFile)) {
    warnings.push(`Agent override '${agentName}' promptOverrideFile not found: ${promptOverrideFile}`);
  }
  if (promptAppendFiles) {
    for (const filePath of promptAppendFiles) {
      if (!existsFile(filePath)) warnings.push(`Agent override '${agentName}' promptAppendFile not found: ${filePath}`);
    }
  }

  const tools = sanitizeStringArray(value.tools);
  const noTools = typeof value.noTools === "boolean" ? value.noTools : undefined;
  if (noTools && tools?.length) {
    warnings.push(`Agent override '${agentName}' specified both noTools=true and tools; tools will be ignored.`);
  }

  return {
    model: isNonEmptyString(value.model) ? value.model.trim() : undefined,
    variant: isNonEmptyString(value.variant) ? value.variant.trim() : undefined,
    options: sanitizeStringArray(value.options),
    tools: noTools ? undefined : tools,
    noTools,
    promptOverrideFile: promptOverrideFile && existsFile(promptOverrideFile) ? promptOverrideFile : undefined,
    promptAppendFiles: promptAppendFiles?.filter((filePath) => existsFile(filePath)),
    promptAppendText: isNonEmptyString(value.promptAppendText) ? value.promptAppendText : undefined,
    allowSkills: sanitizeStringArray(value.allowSkills),
    denySkills: sanitizeStringArray(value.denySkills),
    allowedAdapters: sanitizeStringArray(value.allowedAdapters),
    deniedAdapters: sanitizeStringArray(value.deniedAdapters),
    disabled: typeof value.disabled === "boolean" ? value.disabled : undefined,
  };
}

function getDefaultConfig(): PantheonConfig {
  return {
    appendOrchestratorPrompt: true,
    agents: {},
    council: {
      defaultPreset: "default",
      presets: clonePresetMap(DEFAULT_COUNCIL_PRESETS),
      masterTimeoutMs: 300000,
      councillorsTimeoutMs: 180000,
    },
    fallback: {
      timeoutMs: 15000,
      delegateTimeoutMs: 0,
      retryDelayMs: 500,
      retryOnEmpty: true,
      agentTimeouts: {},
      agentChains: {},
      councilMaster: [],
    },
    background: {
      enabled: true,
      pollIntervalMs: 3000,
      logDir: path.join(getAgentDir(), "oh-my-opencode-pi-tasks"),
      maxConcurrent: 2,
    },
    multiplexer: {
      tmux: false,
      splitDirection: "vertical",
      layout: "main-vertical",
      focusOnSpawn: false,
      keepPaneOnFinish: false,
      reuseWindow: true,
      windowName: "pantheon-bg",
    },
    research: {
      timeoutMs: 15000,
      userAgent: "oh-my-opencode-pi/0.1.0",
      maxResults: 5,
      githubToken: undefined,
      defaultDocsSite: undefined,
    },
    skills: {
      setupHints: true,
      defaultAllow: [],
      defaultDeny: [],
      cartography: {
        enabled: true,
        maxFiles: 250,
        maxDepth: 4,
        maxPerDirectory: 8,
        exclude: [],
      },
    },
    adapters: {
      disableAll: false,
      disabled: [],
      defaultAllow: [],
      defaultDeny: [],
      modules: [],
    },
    delegation: {
      maxDepth: 3,
    },
    autoContinue: {
      enabled: false,
      cooldownMs: 3000,
      maxContinuations: 5,
      autoEnable: false,
      autoEnableThreshold: 4,
    },
    interview: {
      templateTitle: "Project Specification",
    },
    workflow: {
      injectHints: true,
      backgroundAwareness: true,
      todoThreshold: 3,
      persistTodos: true,
      stateFile: ".oh-my-opencode-pi-workflow.json",
      phaseReminders: true,
      postFileToolNudges: true,
      delegateRetryGuidance: true,
    },
    ui: {
      dashboardWidget: true,
      maxTodos: 3,
      maxBackgroundTasks: 3,
    },
    debug: {
      enabled: true,
      logDir: ".oh-my-opencode-pi-debug",
    },
  };
}

export function validatePantheonConfig(input: unknown): PantheonConfigLoadResult {
  const warnings: string[] = [];
  const config = getDefaultConfig();

  if (!isObject(input)) {
    if (input !== undefined) warnings.push("Pantheon config ignored: expected top-level object.");
    return {
      config,
      warnings,
      sources: { globalPath: path.join(getAgentDir(), "oh-my-opencode-pi.json"), projectPath: null },
      activePresets: [],
      availablePresets: Object.keys(DEFAULT_CONFIG_PRESETS),
    };
  }

  if (typeof input.appendOrchestratorPrompt === "boolean") {
    config.appendOrchestratorPrompt = input.appendOrchestratorPrompt;
  }

  if (isObject(input.agents)) {
    config.agents = {};
    for (const [agentName, value] of Object.entries(input.agents)) {
      const override = sanitizeAgentOverride(value, agentName, warnings);
      if (override) config.agents[agentName] = override;
    }
  }

  if (isObject(input.fallback)) {
    if (typeof input.fallback.timeoutMs === "number" && Number.isFinite(input.fallback.timeoutMs) && input.fallback.timeoutMs >= 0) {
      config.fallback!.timeoutMs = Math.floor(input.fallback.timeoutMs);
    }
    if (typeof input.fallback.delegateTimeoutMs === "number" && Number.isFinite(input.fallback.delegateTimeoutMs) && input.fallback.delegateTimeoutMs >= 0) {
      config.fallback!.delegateTimeoutMs = Math.floor(input.fallback.delegateTimeoutMs);
    }
    if (typeof input.fallback.retryDelayMs === "number" && Number.isFinite(input.fallback.retryDelayMs) && input.fallback.retryDelayMs >= 0) {
      config.fallback!.retryDelayMs = Math.floor(input.fallback.retryDelayMs);
    }
    if (typeof input.fallback.retryOnEmpty === "boolean") {
      config.fallback!.retryOnEmpty = input.fallback.retryOnEmpty;
    }
    if (isObject(input.fallback.agentTimeouts)) {
      config.fallback!.agentTimeouts = Object.fromEntries(
        Object.entries(input.fallback.agentTimeouts)
          .filter(([, timeout]) => typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0)
          .map(([name, timeout]) => [name, Math.floor(timeout as number)]),
      );
    }
    if (Array.isArray(input.fallback.councilMaster)) {
      config.fallback!.councilMaster = input.fallback.councilMaster.filter(isNonEmptyString).map((item) => item.trim());
    }
    if (isObject(input.fallback.agentChains)) {
      config.fallback!.agentChains = Object.fromEntries(
        Object.entries(input.fallback.agentChains)
          .map(([name, chain]) => [name, Array.isArray(chain) ? chain.filter(isNonEmptyString).map((item) => item.trim()) : []])
          .filter(([, chain]) => chain.length > 0),
      );
    }
  }

  if (isObject(input.background)) {
    if (typeof input.background.enabled === "boolean") config.background!.enabled = input.background.enabled;
    if (typeof input.background.pollIntervalMs === "number" && Number.isFinite(input.background.pollIntervalMs) && input.background.pollIntervalMs > 0) {
      config.background!.pollIntervalMs = input.background.pollIntervalMs;
    }
    if (typeof input.background.maxConcurrent === "number" && Number.isFinite(input.background.maxConcurrent) && input.background.maxConcurrent >= 1) {
      config.background!.maxConcurrent = Math.floor(input.background.maxConcurrent);
    }
    if (isNonEmptyString(input.background.logDir)) config.background!.logDir = input.background.logDir.trim();
  }

  if (isObject(input.multiplexer)) {
    if (typeof input.multiplexer.tmux === "boolean") config.multiplexer!.tmux = input.multiplexer.tmux;
    if (input.multiplexer.splitDirection === "vertical" || input.multiplexer.splitDirection === "horizontal") {
      config.multiplexer!.splitDirection = input.multiplexer.splitDirection;
    }
    if (["tiled", "even-horizontal", "even-vertical", "main-horizontal", "main-vertical"].includes(String(input.multiplexer.layout))) {
      config.multiplexer!.layout = input.multiplexer.layout as NonNullable<PantheonConfig["multiplexer"]>["layout"];
    }
    if (typeof input.multiplexer.focusOnSpawn === "boolean") config.multiplexer!.focusOnSpawn = input.multiplexer.focusOnSpawn;
    if (typeof input.multiplexer.keepPaneOnFinish === "boolean") config.multiplexer!.keepPaneOnFinish = input.multiplexer.keepPaneOnFinish;
    if (typeof input.multiplexer.reuseWindow === "boolean") config.multiplexer!.reuseWindow = input.multiplexer.reuseWindow;
    if (isNonEmptyString(input.multiplexer.windowName)) config.multiplexer!.windowName = input.multiplexer.windowName.trim();
  }

  if (isObject(input.research)) {
    if (typeof input.research.timeoutMs === "number" && Number.isFinite(input.research.timeoutMs) && input.research.timeoutMs > 0) {
      config.research!.timeoutMs = input.research.timeoutMs;
    }
    if (typeof input.research.maxResults === "number" && Number.isFinite(input.research.maxResults) && input.research.maxResults >= 1) {
      config.research!.maxResults = Math.floor(input.research.maxResults);
    }
    if (isNonEmptyString(input.research.userAgent)) config.research!.userAgent = input.research.userAgent.trim();
    if (isNonEmptyString(input.research.githubToken)) config.research!.githubToken = input.research.githubToken.trim();
    if (isNonEmptyString(input.research.defaultDocsSite)) config.research!.defaultDocsSite = input.research.defaultDocsSite.trim();
  }

  if (isObject(input.skills)) {
    if (typeof input.skills.setupHints === "boolean") config.skills!.setupHints = input.skills.setupHints;
    config.skills!.defaultAllow = sanitizeStringArray(input.skills.defaultAllow) ?? config.skills!.defaultAllow;
    config.skills!.defaultDeny = sanitizeStringArray(input.skills.defaultDeny) ?? config.skills!.defaultDeny;
    if (isObject(input.skills.cartography)) {
      if (typeof input.skills.cartography.enabled === "boolean") config.skills!.cartography!.enabled = input.skills.cartography.enabled;
      if (typeof input.skills.cartography.maxFiles === "number" && Number.isFinite(input.skills.cartography.maxFiles) && input.skills.cartography.maxFiles >= 1) {
        config.skills!.cartography!.maxFiles = Math.floor(input.skills.cartography.maxFiles);
      }
      if (typeof input.skills.cartography.maxDepth === "number" && Number.isFinite(input.skills.cartography.maxDepth) && input.skills.cartography.maxDepth >= 1) {
        config.skills!.cartography!.maxDepth = Math.floor(input.skills.cartography.maxDepth);
      }
      if (typeof input.skills.cartography.maxPerDirectory === "number" && Number.isFinite(input.skills.cartography.maxPerDirectory) && input.skills.cartography.maxPerDirectory >= 1) {
        config.skills!.cartography!.maxPerDirectory = Math.floor(input.skills.cartography.maxPerDirectory);
      }
      config.skills!.cartography!.exclude = sanitizeStringArray(input.skills.cartography.exclude) ?? config.skills!.cartography!.exclude;
    }
  }

  if (isObject(input.adapters)) {
    if (typeof input.adapters.disableAll === "boolean") config.adapters!.disableAll = input.adapters.disableAll;
    config.adapters!.disabled = sanitizeStringArray(input.adapters.disabled) ?? config.adapters!.disabled;
    config.adapters!.defaultAllow = sanitizeStringArray(input.adapters.defaultAllow) ?? config.adapters!.defaultAllow;
    config.adapters!.defaultDeny = sanitizeStringArray(input.adapters.defaultDeny) ?? config.adapters!.defaultDeny;
    config.adapters!.modules = sanitizeStringArray(input.adapters.modules) ?? config.adapters!.modules;
  }

  if (isObject(input.delegation)) {
    if (typeof input.delegation.maxDepth === "number" && Number.isFinite(input.delegation.maxDepth) && input.delegation.maxDepth >= 1) {
      config.delegation!.maxDepth = input.delegation.maxDepth;
    }
  }

  if (isObject(input.autoContinue)) {
    if (typeof input.autoContinue.enabled === "boolean") config.autoContinue!.enabled = input.autoContinue.enabled;
    if (typeof input.autoContinue.cooldownMs === "number" && Number.isFinite(input.autoContinue.cooldownMs) && input.autoContinue.cooldownMs >= 0) {
      config.autoContinue!.cooldownMs = Math.floor(input.autoContinue.cooldownMs);
    }
    if (typeof input.autoContinue.maxContinuations === "number" && Number.isFinite(input.autoContinue.maxContinuations) && input.autoContinue.maxContinuations >= 1) {
      config.autoContinue!.maxContinuations = Math.floor(input.autoContinue.maxContinuations);
    }
    if (typeof input.autoContinue.autoEnable === "boolean") config.autoContinue!.autoEnable = input.autoContinue.autoEnable;
    if (typeof input.autoContinue.autoEnableThreshold === "number" && Number.isFinite(input.autoContinue.autoEnableThreshold) && input.autoContinue.autoEnableThreshold >= 1) {
      config.autoContinue!.autoEnableThreshold = Math.floor(input.autoContinue.autoEnableThreshold);
    }
  }

  if (isObject(input.interview)) {
    if (isNonEmptyString(input.interview.templateTitle)) config.interview!.templateTitle = input.interview.templateTitle.trim();
  }

  if (isObject(input.workflow)) {
    if (typeof input.workflow.injectHints === "boolean") config.workflow!.injectHints = input.workflow.injectHints;
    if (typeof input.workflow.backgroundAwareness === "boolean") config.workflow!.backgroundAwareness = input.workflow.backgroundAwareness;
    if (typeof input.workflow.todoThreshold === "number" && Number.isFinite(input.workflow.todoThreshold) && input.workflow.todoThreshold >= 1) {
      config.workflow!.todoThreshold = Math.floor(input.workflow.todoThreshold);
    }
    if (typeof input.workflow.persistTodos === "boolean") config.workflow!.persistTodos = input.workflow.persistTodos;
    if (isNonEmptyString(input.workflow.stateFile)) config.workflow!.stateFile = input.workflow.stateFile.trim();
    if (typeof input.workflow.phaseReminders === "boolean") config.workflow!.phaseReminders = input.workflow.phaseReminders;
    if (typeof input.workflow.postFileToolNudges === "boolean") config.workflow!.postFileToolNudges = input.workflow.postFileToolNudges;
    if (typeof input.workflow.delegateRetryGuidance === "boolean") config.workflow!.delegateRetryGuidance = input.workflow.delegateRetryGuidance;
  }

  if (isObject(input.ui)) {
    if (typeof input.ui.dashboardWidget === "boolean") config.ui!.dashboardWidget = input.ui.dashboardWidget;
    if (typeof input.ui.maxTodos === "number" && Number.isFinite(input.ui.maxTodos) && input.ui.maxTodos >= 1) {
      config.ui!.maxTodos = Math.floor(input.ui.maxTodos);
    }
    if (typeof input.ui.maxBackgroundTasks === "number" && Number.isFinite(input.ui.maxBackgroundTasks) && input.ui.maxBackgroundTasks >= 1) {
      config.ui!.maxBackgroundTasks = Math.floor(input.ui.maxBackgroundTasks);
    }
  }

  if (isObject(input.debug)) {
    if (typeof input.debug.enabled === "boolean") config.debug!.enabled = input.debug.enabled;
    if (isNonEmptyString(input.debug.logDir)) config.debug!.logDir = input.debug.logDir.trim();
  }

  if (input.council !== undefined) {
    if (!isObject(input.council)) {
      warnings.push("'council' ignored: expected object.");
    } else {
      if (isNonEmptyString(input.council.defaultPreset)) {
        config.council!.defaultPreset = input.council.defaultPreset.trim();
      }
      if (typeof input.council.masterTimeoutMs === "number" && Number.isFinite(input.council.masterTimeoutMs) && input.council.masterTimeoutMs > 0) {
        config.council!.masterTimeoutMs = Math.floor(input.council.masterTimeoutMs);
      }
      if (typeof input.council.councillorsTimeoutMs === "number" && Number.isFinite(input.council.councillorsTimeoutMs) && input.council.councillorsTimeoutMs > 0) {
        config.council!.councillorsTimeoutMs = Math.floor(input.council.councillorsTimeoutMs);
      }
      if (input.council.presets !== undefined) {
        if (!isObject(input.council.presets)) {
          warnings.push("'council.presets' ignored: expected object.");
        } else {
          config.council!.presets = {};
          for (const [presetName, presetValue] of Object.entries(input.council.presets)) {
            const preset = sanitizeCouncilPreset(presetValue, presetName, warnings);
            if (preset) config.council!.presets![presetName] = preset;
          }
          if (Object.keys(config.council!.presets!).length === 0) {
            config.council!.presets = clonePresetMap(DEFAULT_COUNCIL_PRESETS);
          }
        }
      }
    }
  }

  if (!config.council?.presets?.[config.council.defaultPreset ?? "default"]) {
    warnings.push(`Default council preset '${config.council?.defaultPreset}' not found; falling back to 'default'.`);
    config.council = config.council ?? {};
    config.council.defaultPreset = "default";
    config.council.presets = {
      ...clonePresetMap(DEFAULT_COUNCIL_PRESETS),
      ...(config.council.presets ?? {}),
    };
  }

  return {
    config,
    warnings,
    sources: {
      globalPath: path.join(getAgentDir(), "oh-my-opencode-pi.json"),
      projectPath: null,
    },
    activePresets: [],
    availablePresets: Object.keys(DEFAULT_CONFIG_PRESETS),
  };
}

export function loadPantheonConfig(cwd: string): PantheonConfigLoadResult {
  const warnings: string[] = [];
  const globalPath = findFirstExistingPath([
    path.join(getAgentDir(), "oh-my-opencode-pi.json"),
    path.join(getAgentDir(), "oh-my-opencode-pi.jsonc"),
  ]);
  const projectPath = findNearestProjectPath(cwd, [
    path.join(".pi", "oh-my-opencode-pi.json"),
    path.join(".pi", "oh-my-opencode-pi.jsonc"),
  ]);

  const globalConfig = globalPath ? loadJsoncFile(globalPath, warnings) : {};
  const projectConfig = projectPath ? loadJsoncFile(projectPath, warnings) : {};

  const globalPresetMap = {
    ...cloneUnknown(DEFAULT_CONFIG_PRESETS),
    ...toRawPresetMap(globalConfig.presets),
  };
  const globalResolved = resolveConfigWithPresets(globalConfig, globalPresetMap, warnings);

  const allPresetMap = {
    ...globalPresetMap,
    ...toRawPresetMap(projectConfig.presets),
  };
  const projectResolved = resolveConfigWithPresets(projectConfig, allPresetMap, warnings);

  const merged = deepMerge(globalResolved.config, projectResolved.config);
  const result = validatePantheonConfig(merged);
  result.warnings = [...warnings, ...result.warnings].filter((item, index, array) => array.indexOf(item) === index);
  result.sources.globalPath = globalPath ?? path.join(getAgentDir(), "oh-my-opencode-pi.json");
  result.sources.projectPath = projectPath;
  result.activePresets = [...globalResolved.activePresets, ...projectResolved.activePresets].filter((item, index, array) => array.indexOf(item) === index);
  result.availablePresets = Object.keys(allPresetMap).sort();
  return result;
}

export function resolveCouncilPreset(config: PantheonConfig): { name: string; preset: CouncilPresetConfig } {
  const presets = config.council?.presets ?? {};
  const defaultName = config.council?.defaultPreset ?? "default";
  const preset = presets[defaultName] ?? presets.default ?? DEFAULT_COUNCIL_PRESET;
  return { name: presets[defaultName] ? defaultName : "default", preset };
}

export function listCouncilPresetNames(config: PantheonConfig): string[] {
  return Object.keys(config.council?.presets ?? {});
}

export function resolveConfiguredAgentOverride(config: PantheonConfig, agentName: string): AgentOverrideConfig | undefined {
  return config.agents?.[agentName];
}

export function resolveConfiguredAgentModel(model: string | undefined, variant: string | undefined): string | undefined {
  return buildModelPattern(model, variant);
}

function mergePolicyLists(defaults: string[] | undefined, overrides: string[] | undefined): string[] {
  return [...new Set([...(defaults ?? []), ...(overrides ?? [])].filter(Boolean))];
}

export function resolveAgentSkillPolicy(config: PantheonConfig, agentName: string): { allow: string[]; deny: string[]; cartographyEnabled: boolean } {
  const override = resolveConfiguredAgentOverride(config, agentName);
  return {
    allow: mergePolicyLists(config.skills?.defaultAllow, override?.allowSkills),
    deny: mergePolicyLists(config.skills?.defaultDeny, override?.denySkills),
    cartographyEnabled: config.skills?.cartography?.enabled !== false,
  };
}

export function resolveAgentAdapterPolicy(config: PantheonConfig, agentName: string): { disableAll: boolean; allow: string[]; deny: string[]; disabled: string[] } {
  const override = resolveConfiguredAgentOverride(config, agentName);
  return {
    disableAll: config.adapters?.disableAll === true,
    allow: mergePolicyLists(config.adapters?.defaultAllow, override?.allowedAdapters),
    deny: mergePolicyLists(config.adapters?.defaultDeny, override?.deniedAdapters),
    disabled: [...new Set(config.adapters?.disabled ?? [])],
  };
}

export function listConfigPresetNames(result: PantheonConfigLoadResult): string[] {
  return result.availablePresets;
}
