import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./agents.js";
import type { PantheonConfig } from "./config.js";
import { loadPantheonConfig } from "./config.js";
import { getFallbackModels, resolveBackgroundAttemptTimeoutMs } from "./hooks/fallback.js";
import type { BackgroundTaskRecord, BackgroundTaskSpec } from "./types.js";

const SUBAGENT_ENV = "OH_MY_OPENCODE_PI_SUBAGENT";
const DEPTH_ENV = "OH_MY_OPENCODE_PI_DEPTH";

function previewText(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function getRunnerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./background-runner.mjs");
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readBackgroundTaskFile(filePath: string): BackgroundTaskRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as BackgroundTaskRecord;
  } catch {
    return undefined;
  }
}

function writeBackgroundTask(task: BackgroundTaskRecord): void {
  fs.writeFileSync(task.resultPath, JSON.stringify(task, null, 2));
}

export function listBackgroundTasks(taskDir: string): BackgroundTaskRecord[] {
  if (!fs.existsSync(taskDir)) return [];
  return fs.readdirSync(taskDir)
    .filter((file) => file.endsWith(".result.json"))
    .map((file) => readBackgroundTaskFile(path.join(taskDir, file)))
    .filter((item): item is BackgroundTaskRecord => Boolean(item))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function readBackgroundTaskSpec(specPath: string): BackgroundTaskSpec | undefined {
  try {
    return JSON.parse(fs.readFileSync(specPath, "utf8")) as BackgroundTaskSpec;
  } catch {
    return undefined;
  }
}

export function summarizeBackgroundCounts(tasks: BackgroundTaskRecord[]): string {
  const queued = tasks.filter((task) => task.status === "queued").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  if (queued + running + failed + completed === 0) return "Pantheon background: idle";
  return `Pantheon background: ${running} running, ${queued} queued${failed > 0 ? `, ${failed} failed` : ""}${completed > 0 ? `, ${completed} done` : ""}`;
}

export function renderBackgroundOverview(tasks: BackgroundTaskRecord[], maxRecent = 8): string {
  const queued = tasks.filter((task) => task.status === "queued");
  const running = tasks.filter((task) => task.status === "running");
  const completed = tasks.filter((task) => task.status === "completed");
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "cancelled");
  const recent = tasks.slice(0, Math.max(1, maxRecent));

  return [
    summarizeBackgroundCounts(tasks),
    `\nQueued: ${queued.length}`,
    `Running: ${running.length}`,
    `Completed: ${completed.length}`,
    `Failed/Cancelled: ${failed.length}`,
    recent.length > 0 ? `\nRecent tasks:\n${recent.map((task) => `- ${task.id} [${task.status}] ${task.agent} — ${task.summary ?? previewText(task.task, 120)}`).join("\n")}` : undefined,
  ].filter((item): item is string => Boolean(item)).join("\n");
}

export function getBackgroundStatusCounts(tasks: BackgroundTaskRecord[]) {
  return {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function maybeApplyTmuxLayout(layout?: NonNullable<PantheonConfig["multiplexer"]>["layout"]): void {
  if (!layout || !process.env.TMUX) return;
  try {
    execFileSync("tmux", ["select-layout", layout], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // ignore missing support
  }
}

function maybeFocusTmuxPane(paneId?: string, enabled?: boolean): void {
  if (!paneId || !enabled || !process.env.TMUX) return;
  try {
    execFileSync("tmux", ["select-pane", "-t", paneId], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // ignore focus errors
  }
}

function maybeSetTmuxPaneTitle(paneId: string | undefined, title: string): void {
  if (!paneId || !process.env.TMUX) return;
  try {
    execFileSync("tmux", ["select-pane", "-t", paneId, "-T", previewText(title, 40)], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // ignore title errors
  }
}

function maybeOpenTmuxPane(logPath: string, title: string, multiplexer: PantheonConfig["multiplexer"] | undefined): string | undefined {
  if (!process.env.TMUX || !multiplexer?.tmux) return undefined;
  try {
    const flag = multiplexer.splitDirection === "horizontal" ? "-h" : "-v";
    const command = `tail -f ${shellEscape(logPath)}`;
    const paneId = execFileSync("tmux", ["split-window", flag, "-d", "-P", "-F", "#{pane_id}", command], {
      shell: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    maybeSetTmuxPaneTitle(paneId || undefined, title);
    maybeApplyTmuxLayout(multiplexer.layout);
    maybeFocusTmuxPane(paneId || undefined, multiplexer.focusOnSpawn);
    return paneId || undefined;
  } catch {
    return undefined;
  }
}

export function closeTmuxPane(paneId?: string): void {
  if (!paneId || !process.env.TMUX) return;
  try {
    execFileSync("tmux", ["kill-pane", "-t", paneId], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // ignore cleanup errors
  }
}

export function attachBackgroundTaskPane(task: BackgroundTaskRecord, multiplexer: PantheonConfig["multiplexer"] | undefined): BackgroundTaskRecord {
  const paneId = maybeOpenTmuxPane(task.logPath, `${task.agent}: ${task.summary ?? task.task}`, multiplexer);
  if (!paneId) return task;
  const updated = { ...task, paneId };
  writeBackgroundTask(updated);
  return updated;
}

export function startBackgroundTaskProcess(ctxCwd: string, task: BackgroundTaskRecord, multiplexer: PantheonConfig["multiplexer"] | undefined): BackgroundTaskRecord {
  const specPath = task.specPath ?? task.resultPath.replace(/\.result\.json$/, ".spec.json");
  const spec = readBackgroundTaskSpec(specPath);
  const runnerPath = getRunnerPath();
  const proc = spawn(process.execPath, [runnerPath, specPath], {
    cwd: ctxCwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [SUBAGENT_ENV]: "1", [DEPTH_ENV]: String((spec?.depth ?? 0) + 1) },
  });
  const updated: BackgroundTaskRecord = {
    ...task,
    status: "running",
    pid: proc.pid,
    startedAt: Date.now(),
  };
  proc.unref();
  if (!updated.paneId) {
    updated.paneId = maybeOpenTmuxPane(updated.logPath, `${updated.agent}: ${updated.task}`, multiplexer);
  }
  writeBackgroundTask(updated);
  return updated;
}

export function enqueueBackgroundSpec(
  ctxCwd: string,
  seed: Omit<BackgroundTaskSpec, "logPath" | "resultPath" | "meta"> & { includeProjectAgents?: boolean; depth?: number },
  options: {
    taskDir: string;
    randomId: (prefix: string) => string;
    retryOf?: string;
    maxConcurrent?: number;
    onEnqueue?: (taskId: string) => void;
  },
): BackgroundTaskRecord {
  const config = loadPantheonConfig(ctxCwd).config;
  const id = options.randomId("pantheon");
  const logPath = path.join(options.taskDir, `${id}.log`);
  const resultPath = path.join(options.taskDir, `${id}.result.json`);
  const specPath = path.join(options.taskDir, `${id}.spec.json`);
  const maxConcurrent = options.maxConcurrent ?? config.background?.maxConcurrent ?? 2;
  const runningNow = reconcileBackgroundTasks(options.taskDir, config.multiplexer).filter((item) => item.status === "queued" || item.status === "running").length;
  const record: BackgroundTaskRecord = {
    id,
    agent: seed.agent,
    task: seed.task,
    status: "queued",
    createdAt: Date.now(),
    logPath,
    resultPath,
    specPath,
    summary: options.retryOf ? `Retry of ${options.retryOf}` : undefined,
  };

  const spec: BackgroundTaskSpec = {
    ...seed,
    logPath,
    resultPath,
    meta: record,
    includeProjectAgents: seed.includeProjectAgents ?? false,
    depth: seed.depth ?? 0,
  };

  fs.writeFileSync(resultPath, JSON.stringify(record, null, 2));
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  options.onEnqueue?.(id);

  if (runningNow < maxConcurrent) {
    return startBackgroundTaskProcess(ctxCwd, record, config.multiplexer);
  }

  const queued = {
    ...record,
    summary: options.retryOf
      ? `Retry of ${options.retryOf} queued (waiting for free worker slot; max concurrent ${maxConcurrent})`
      : `Queued (waiting for free worker slot; max concurrent ${maxConcurrent})`,
  };
  fs.writeFileSync(resultPath, JSON.stringify(queued, null, 2));
  return queued;
}

export function launchBackgroundTask(
  ctxCwd: string,
  agent: AgentConfig,
  task: string,
  includeProjectAgents: boolean,
  cwd: string | undefined,
  options: {
    taskDir: string;
    randomId: (prefix: string) => string;
    currentDepth: number;
    onEnqueue?: (taskId: string) => void;
    getPiInvocation: (args: string[]) => { command: string; args: string[] };
  },
): BackgroundTaskRecord {
  const config = loadPantheonConfig(ctxCwd).config;
  const piInvocation = options.getPiInvocation([]);
  return enqueueBackgroundSpec(ctxCwd, {
    agent: agent.name,
    task,
    cwd: cwd ?? ctxCwd,
    model: agent.model,
    models: getFallbackModels(config, agent.name, agent.model),
    options: agent.options,
    tools: agent.tools,
    noTools: agent.noTools,
    systemPrompt: agent.systemPrompt,
    piCommand: piInvocation.command,
    piBaseArgs: piInvocation.args,
    timeoutMs: resolveBackgroundAttemptTimeoutMs(config),
    retryDelayMs: Math.max(0, Math.floor(config.fallback?.retryDelayMs ?? 500)),
    retryOnEmpty: config.fallback?.retryOnEmpty !== false,
    includeProjectAgents,
    depth: options.currentDepth,
  }, {
    taskDir: options.taskDir,
    randomId: options.randomId,
    maxConcurrent: config.background?.maxConcurrent ?? 2,
    onEnqueue: options.onEnqueue,
  });
}

export function retryBackgroundTask(
  ctxCwd: string,
  task: BackgroundTaskRecord,
  options: {
    taskDir: string;
    randomId: (prefix: string) => string;
    onEnqueue?: (taskId: string) => void;
  },
): BackgroundTaskRecord | undefined {
  const specPath = task.specPath ?? task.resultPath.replace(/\.result\.json$/, ".spec.json");
  const spec = readBackgroundTaskSpec(specPath);
  if (!spec) return undefined;
  return enqueueBackgroundSpec(ctxCwd, {
    agent: spec.agent,
    task: spec.task,
    cwd: spec.cwd,
    model: spec.model,
    models: spec.models,
    options: spec.options,
    tools: spec.tools,
    noTools: spec.noTools,
    systemPrompt: spec.systemPrompt,
    piCommand: spec.piCommand,
    piBaseArgs: spec.piBaseArgs,
    timeoutMs: spec.timeoutMs,
    retryDelayMs: spec.retryDelayMs,
    retryOnEmpty: spec.retryOnEmpty,
    includeProjectAgents: spec.includeProjectAgents,
    depth: spec.depth,
  }, {
    taskDir: options.taskDir,
    randomId: options.randomId,
    retryOf: task.id,
    onEnqueue: options.onEnqueue,
  });
}

export function maybeStartQueuedTasks(ctxCwd: string, taskDir: string): BackgroundTaskRecord[] {
  const config = loadPantheonConfig(ctxCwd).config;
  const tasks = listBackgroundTasks(taskDir);
  const maxConcurrent = config.background?.maxConcurrent ?? 2;
  let running = tasks.filter((task) => task.status === "running").length;
  return tasks.map((task) => {
    if (task.status === "queued" && running < maxConcurrent) {
      running++;
      return startBackgroundTaskProcess(ctxCwd, task, config.multiplexer);
    }
    return task;
  });
}

export function reconcileBackgroundTasks(taskDir: string, multiplexer?: PantheonConfig["multiplexer"]): BackgroundTaskRecord[] {
  const tasks = listBackgroundTasks(taskDir);
  return tasks.map((task) => {
    if (task.status === "running" && !isProcessAlive(task.pid)) {
      const updated: BackgroundTaskRecord = {
        ...task,
        status: "failed",
        finishedAt: task.finishedAt ?? Date.now(),
        summary: task.summary ?? "Task process was not running during reconciliation.",
      };
      writeBackgroundTask(updated);
      if (!multiplexer?.keepPaneOnFinish) closeTmuxPane(updated.paneId);
      return updated;
    }
    return task;
  });
}

export function tailLog(logPath: string, maxLines = 80): string {
  if (!fs.existsSync(logPath)) return "(no log file)";
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n").trim() || "(log empty)";
}

export function cleanupBackgroundArtifacts(taskDir: string, keepCount = 50): { removed: number; kept: number } {
  const tasks = listBackgroundTasks(taskDir);
  const removable = tasks.slice(keepCount).filter((task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled");
  let removed = 0;
  for (const task of removable) {
    for (const filePath of [task.resultPath, task.logPath, task.resultPath.replace(/\.result\.json$/, ".spec.json")]) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    removed++;
  }
  return { removed, kept: tasks.length - removed };
}

export function cancelBackgroundTask(task: BackgroundTaskRecord, multiplexer?: PantheonConfig["multiplexer"]): BackgroundTaskRecord {
  if (task.pid) {
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  if (!multiplexer?.keepPaneOnFinish) closeTmuxPane(task.paneId);
  const updated: BackgroundTaskRecord = {
    ...task,
    status: "cancelled",
    finishedAt: Date.now(),
    summary: task.summary ?? "Cancelled by user",
  };
  fs.writeFileSync(task.resultPath, JSON.stringify(updated, null, 2));
  return updated;
}
