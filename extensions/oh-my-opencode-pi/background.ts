import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./agents.js";
import type { PantheonConfig } from "./config.js";
import { loadPantheonConfig } from "./config.js";
import { getFallbackModels, resolveBackgroundAttemptTimeoutMs, resolveFinalMessageGraceMs } from "./hooks/fallback.js";
import type { BackgroundTaskRecord, BackgroundTaskSpec } from "./types.js";

const SUBAGENT_ENV = "OH_MY_OPENCODE_PI_SUBAGENT";
const DEPTH_ENV = "OH_MY_OPENCODE_PI_DEPTH";

function previewText(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function summarizeSingleResult(task: BackgroundTaskRecord["result"]): string {
  if (!task) return "(no output)";
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const message = task.messages[i];
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (part.type === "text" && part.text.trim()) return part.text.trim();
    }
  }
  if (task.errorMessage?.trim()) return task.errorMessage.trim();
  if (task.stderr.trim()) return task.stderr.trim();
  return "(no output)";
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

export function summarizeBackgroundCounts(tasks: BackgroundTaskRecord[], staleAfterMs = 20000): string {
  const queued = tasks.filter((task) => task.status === "queued").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const stale = tasks.filter((task) => isTaskStale(task, staleAfterMs)).length;
  if (queued + running + failed + completed === 0) return "Pantheon background: idle";
  return `Pantheon background: ${running} running, ${queued} queued${stale > 0 ? `, ${stale} stale` : ""}${failed > 0 ? `, ${failed} failed` : ""}${completed > 0 ? `, ${completed} done` : ""}`;
}

export function describeBackgroundTask(task: BackgroundTaskRecord, maxPreview = 120, staleAfterMs = 20000): string {
  return `${task.id} [${isTaskStale(task, staleAfterMs) ? `${task.status}/stale` : task.status}] ${task.agent} — ${task.summary ?? previewText(task.task, maxPreview)}`;
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 6) / 10;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours}h`;
}

function deriveTaskDuration(task: BackgroundTaskRecord, now = Date.now()): number | undefined {
  if (typeof task.result?.durationMs === "number") return task.result.durationMs;
  if (typeof task.finishedAt === "number" && typeof task.startedAt === "number") return Math.max(0, task.finishedAt - task.startedAt);
  if ((task.status === "running" || task.status === "queued") && typeof task.startedAt === "number") return Math.max(0, now - task.startedAt);
  return undefined;
}

function formatTaskHeading(task: BackgroundTaskRecord, staleAfterMs = 20000): string {
  const state = isTaskStale(task, staleAfterMs) ? `${task.status}/stale` : task.status;
  return `${task.id} • ${state} • ${task.agent} • ${formatDuration(deriveTaskDuration(task))}`;
}

function summarizeTaskState(task: BackgroundTaskRecord): string {
  const resultText = summarizeSingleResult(task.result);
  if (task.summary?.trim()) return task.summary.trim();
  return resultText;
}

function summarizeTaskDetail(task: BackgroundTaskRecord): string | undefined {
  const resultText = summarizeSingleResult(task.result);
  if (!resultText || resultText === "(no output)") return undefined;
  if (task.summary?.trim() && task.summary.trim() === resultText.trim()) return undefined;
  return resultText.trim();
}

function buildBackgroundDetails(task: BackgroundTaskRecord): string[] {
  return [
    `Task: ${task.task}`,
    task.sessionKey ? `Session key: ${task.sessionKey}` : undefined,
    `Created: ${new Date(task.createdAt).toISOString()}`,
    task.startedAt ? `Started: ${new Date(task.startedAt).toISOString()}` : undefined,
    task.finishedAt ? `Finished: ${new Date(task.finishedAt).toISOString()}` : undefined,
    `Heartbeat: ${formatAge(task.heartbeatAt)}`,
    `Watched: ${task.watchCount ?? 0}`,
    task.reusedFrom ? `Reused from: ${task.reusedFrom}` : undefined,
  ].filter((line): line is string => Boolean(line));
}

export function buildBackgroundNextSteps(task: BackgroundTaskRecord, staleAfterMs = 20000): string[] {
  const stale = isTaskStale(task, staleAfterMs);
  if (task.status === "queued" || task.status === "running") {
    return [
      `- /pantheon-watch ${task.id}`,
      `- /pantheon-log ${task.id}`,
      ...(process.env.TMUX ? [`- /pantheon-attach ${task.id}`] : []),
      `- /pantheon-task-actions ${task.id}`,
    ];
  }
  if (task.status === "failed" || task.status === "cancelled" || stale) {
    return [
      `- /pantheon-result ${task.id}`,
      `- /pantheon-log ${task.id}`,
      `- /pantheon-retry ${task.id}`,
      `- /pantheon-task-actions ${task.id}`,
    ];
  }
  return [
    `- /pantheon-result ${task.id}`,
    `- /pantheon-log ${task.id}`,
    `- /pantheon-task-actions ${task.id}`,
  ];
}

export function renderBackgroundOverview(tasks: BackgroundTaskRecord[], maxRecent = 8, staleAfterMs = 20000): string {
  const queued = tasks.filter((task) => task.status === "queued");
  const running = tasks.filter((task) => task.status === "running");
  const completed = tasks.filter((task) => task.status === "completed");
  const failed = tasks.filter((task) => task.status === "failed" || task.status === "cancelled");
  const stale = tasks.filter((task) => isTaskStale(task, staleAfterMs));
  const recent = tasks.slice(0, Math.max(1, maxRecent));
  const terminal = completed.length + failed.length;
  const completionRate = terminal > 0 ? `${Math.round((completed.length / terminal) * 100)}%` : "n/a";
  const attentionTask = tasks.find((task) => task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs));
  const activeTask = tasks.find((task) => task.status === "queued" || task.status === "running");

  if (tasks.length === 0) {
    return [
      "Pantheon background: idle",
      "",
      "No background tasks yet.",
      "Suggested next steps:",
      "- Start detached work with pantheon_background",
      "- Use /pantheon for the interactive launcher",
    ].join("\n");
  }

  return [
    attentionTask
      ? `Pantheon background: attention needed — ${attentionTask.id}`
      : activeTask
        ? `Pantheon background: active — ${activeTask.id}`
        : summarizeBackgroundCounts(tasks, staleAfterMs),
    `Queued: ${queued.length}`,
    `Running: ${running.length}`,
    `Completed: ${completed.length}`,
    `Failed/Cancelled: ${failed.length}`,
    `Stale: ${stale.length}`,
    `Completion rate: ${completionRate}`,
    attentionTask ? `\nNow:\n- ${formatTaskHeading(attentionTask, staleAfterMs)}\n- ${summarizeTaskState(attentionTask)}` : undefined,
    recent.length > 0 ? `\nRecent tasks:\n${recent.map((task) => `- ${formatTaskHeading(task, staleAfterMs)} — ${previewText(task.summary ?? task.task, 100)}`).join("\n")}` : undefined,
    attentionTask
      ? `\nSuggested next steps:\n${buildBackgroundNextSteps(attentionTask, staleAfterMs).join("\n")}`
      : activeTask
        ? `\nSuggested next steps:\n${buildBackgroundNextSteps(activeTask, staleAfterMs).join("\n")}`
        : undefined,
  ].filter((item): item is string => Boolean(item)).join("\n");
}

export function getBackgroundStatusCounts(tasks: BackgroundTaskRecord[], staleAfterMs = 20000) {
  return {
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    stale: tasks.filter((task) => isTaskStale(task, staleAfterMs)).length,
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}

export function getBackgroundSessionKey(agent: string, cwd: string, task: string): string {
  return `${agent}:${hashText(`${cwd}::${task.trim().toLowerCase()}`)}`;
}

export function isTaskStale(task: BackgroundTaskRecord, staleAfterMs = 20000, now = Date.now()): boolean {
  if (task.status !== "running") return false;
  const heartbeatAt = task.heartbeatAt ?? task.startedAt ?? task.createdAt;
  return now - heartbeatAt > Math.max(1000, staleAfterMs);
}

function formatAge(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return "n/a";
  const delta = Math.max(0, now - timestamp);
  if (delta < 1000) return `${delta}ms ago`;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function renderBackgroundWatch(task: BackgroundTaskRecord, maxLines = 80, staleAfterMs = 20000): string {
  return [
    formatTaskHeading(task, staleAfterMs),
    summarizeTaskState(task),
    summarizeTaskDetail(task),
    "",
    "Next:",
    ...buildBackgroundNextSteps(task, staleAfterMs),
    "",
    "Recent log:",
    tailLog(task.logPath, maxLines),
    "",
    "Details:",
    ...buildBackgroundDetails(task),
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function renderBackgroundResult(task: BackgroundTaskRecord, options?: { includeLogTail?: boolean; logLines?: number; staleAfterMs?: number }): string {
  const staleAfterMs = options?.staleAfterMs ?? 20000;
  const includeLogTail = options?.includeLogTail || task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs);
  const logTail = includeLogTail ? tailLog(task.logPath, Math.max(1, Math.floor(options?.logLines ?? 60))) : undefined;
  return [
    formatTaskHeading(task, staleAfterMs),
    summarizeTaskState(task),
    summarizeTaskDetail(task),
    "",
    "Next:",
    ...buildBackgroundNextSteps(task, staleAfterMs),
    logTail ? "" : undefined,
    logTail ? "Recent log:" : undefined,
    logTail,
    "",
    "Details:",
    ...buildBackgroundDetails(task),
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function findReusableBackgroundTask(tasks: BackgroundTaskRecord[], sessionKey: string | undefined, staleAfterMs: number): BackgroundTaskRecord | undefined {
  if (!sessionKey) return undefined;
  return tasks.find((task) => task.sessionKey === sessionKey && (task.status === "queued" || (task.status === "running" && !isTaskStale(task, staleAfterMs))));
}

function tmuxCapture(args: string[]): string | undefined {
  if (!process.env.TMUX) return undefined;
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function maybeApplyTmuxLayout(layout?: NonNullable<PantheonConfig["multiplexer"]>["layout"], targetWindow?: string): void {
  if (!layout || !process.env.TMUX) return;
  try {
    execFileSync("tmux", targetWindow ? ["select-layout", "-t", targetWindow, layout] : ["select-layout", layout], { stdio: ["ignore", "ignore", "ignore"] });
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

function isTmuxPaneAlive(paneId?: string): boolean {
  if (!paneId || !process.env.TMUX) return false;
  return Boolean(tmuxCapture(["display-message", "-p", "-t", paneId, "#{pane_id}"]));
}

export function getMultiplexerWindowName(ctxCwd: string, multiplexer: PantheonConfig["multiplexer"] | undefined): string {
  const base = multiplexer?.windowName?.trim() || "pantheon-bg";
  if (multiplexer?.projectScopedWindow === false) return base;
  const project = path.basename(ctxCwd) || "project";
  return `${base}-${project}-${hashText(ctxCwd)}`;
}

function ensureTmuxWindow(ctxCwd: string, multiplexer: PantheonConfig["multiplexer"] | undefined): { paneId?: string; windowTarget?: string } {
  if (!process.env.TMUX || !multiplexer?.tmux) return {};
  const windowName = getMultiplexerWindowName(ctxCwd, multiplexer);
  if (multiplexer.reuseWindow === false) return {};
  const existingWindow = tmuxCapture(["list-windows", "-F", "#{window_id}:#{window_name}"])
    ?.split(/\r?\n/)
    .find((line) => line.endsWith(`:${windowName}`));
  if (existingWindow) {
    const windowId = existingWindow.split(":")[0];
    const firstPaneId = tmuxCapture(["list-panes", "-t", windowId, "-F", "#{pane_id}"])
      ?.split(/\r?\n/)
      .find(Boolean);
    return { paneId: firstPaneId || undefined, windowTarget: windowId };
  }
  const paneId = tmuxCapture(["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", windowName, "sh", "-lc", "printf 'Pantheon background window ready\\n'; exec sh"]);
  const windowTarget = paneId ? tmuxCapture(["display-message", "-p", "-t", paneId, "#{window_id}"]) : undefined;
  return { paneId: paneId || undefined, windowTarget: windowTarget || undefined };
}

function focusTmuxWindow(ctxCwd: string, multiplexer: PantheonConfig["multiplexer"] | undefined): void {
  if (!process.env.TMUX || !multiplexer?.tmux || !multiplexer.focusOnSpawn) return;
  const windowName = getMultiplexerWindowName(ctxCwd, multiplexer);
  try {
    execFileSync("tmux", ["select-window", "-t", windowName], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // ignore
  }
}

function maybeOpenTmuxPane(ctxCwd: string, logPath: string, title: string, multiplexer: PantheonConfig["multiplexer"] | undefined): string | undefined {
  if (!process.env.TMUX || !multiplexer?.tmux) return undefined;
  try {
    const flag = multiplexer.splitDirection === "horizontal" ? "-h" : "-v";
    const command = `tail -f ${shellEscape(logPath)}`;
    const window = ensureTmuxWindow(ctxCwd, multiplexer);
    const splitArgs = ["split-window", flag, "-d", "-P", "-F", "#{pane_id}"];
    if (window.windowTarget) splitArgs.push("-t", window.windowTarget);
    splitArgs.push(command);
    const paneId = execFileSync("tmux", splitArgs, {
      shell: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    maybeSetTmuxPaneTitle(paneId || undefined, title);
    maybeApplyTmuxLayout(multiplexer.layout, window.windowTarget);
    maybeFocusTmuxPane(paneId || undefined, multiplexer.focusOnSpawn);
    focusTmuxWindow(ctxCwd, multiplexer);
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

export function attachAllBackgroundTaskPanes(tasks: BackgroundTaskRecord[], multiplexer: PantheonConfig["multiplexer"] | undefined, ctxCwd = process.cwd()): BackgroundTaskRecord[] {
  return tasks.map((task) => (task.status === "queued" || task.status === "running") ? attachBackgroundTaskPane(task, multiplexer, ctxCwd) : task);
}

export function attachBackgroundTaskPane(task: BackgroundTaskRecord, multiplexer: PantheonConfig["multiplexer"] | undefined, ctxCwd = process.cwd()): BackgroundTaskRecord {
  if (isTmuxPaneAlive(task.paneId)) {
    maybeFocusTmuxPane(task.paneId, true);
    focusTmuxWindow(ctxCwd, multiplexer);
    const watched = { ...task, watchCount: (task.watchCount ?? 0) + 1 };
    writeBackgroundTask(watched);
    return watched;
  }
  const paneId = maybeOpenTmuxPane(ctxCwd, task.logPath, `${task.agent}: ${task.summary ?? task.task}`, multiplexer);
  if (!paneId) return task;
  const updated = { ...task, paneId, watchCount: (task.watchCount ?? 0) + 1 };
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
    heartbeatAt: Date.now(),
  };
  proc.unref();
  if (!isTmuxPaneAlive(updated.paneId)) {
    updated.paneId = maybeOpenTmuxPane(ctxCwd, updated.logPath, `${updated.agent}: ${updated.task}`, multiplexer);
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
  const staleAfterMs = config.background?.staleAfterMs ?? 20000;
  const sessionKey = getBackgroundSessionKey(seed.agent, seed.cwd, seed.task);
  const reconciled = reconcileBackgroundTasks(options.taskDir, config.multiplexer, staleAfterMs);
  const reusable = config.background?.reuseSessions === false ? undefined : findReusableBackgroundTask(reconciled, sessionKey, staleAfterMs);
  if (reusable) {
    const updated: BackgroundTaskRecord = {
      ...reusable,
      summary: `Reused active background session ${reusable.id}`,
      reusedFrom: reusable.id,
      watchCount: reusable.watchCount ?? 0,
    };
    writeBackgroundTask(updated);
    return updated;
  }

  const id = options.randomId("pantheon");
  const logPath = path.join(options.taskDir, `${id}.log`);
  const resultPath = path.join(options.taskDir, `${id}.result.json`);
  const specPath = path.join(options.taskDir, `${id}.spec.json`);
  const maxConcurrent = options.maxConcurrent ?? config.background?.maxConcurrent ?? 2;
  const runningNow = reconciled.filter((item) => item.status === "queued" || item.status === "running").length;
  const record: BackgroundTaskRecord = {
    id,
    agent: seed.agent,
    task: seed.task,
    status: "queued",
    createdAt: Date.now(),
    logPath,
    resultPath,
    specPath,
    sessionKey,
    summary: options.retryOf ? `Retry of ${options.retryOf}` : undefined,
  };

  const spec: BackgroundTaskSpec = {
    ...seed,
    logPath,
    resultPath,
    finalMessageGraceMs: seed.finalMessageGraceMs ?? resolveFinalMessageGraceMs(config),
    heartbeatIntervalMs: seed.heartbeatIntervalMs ?? config.background?.heartbeatIntervalMs ?? 1500,
    staleAfterMs: seed.staleAfterMs ?? config.background?.staleAfterMs ?? 20000,
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
    finalMessageGraceMs: resolveFinalMessageGraceMs(config),
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
    finalMessageGraceMs: spec.finalMessageGraceMs,
    heartbeatIntervalMs: spec.heartbeatIntervalMs,
    staleAfterMs: spec.staleAfterMs,
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
  const tasks = reconcileBackgroundTasks(taskDir, config.multiplexer, config.background?.staleAfterMs ?? 20000);
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

export function reconcileBackgroundTasks(taskDir: string, multiplexer?: PantheonConfig["multiplexer"], staleAfterMs = 20000): BackgroundTaskRecord[] {
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
    if (isTaskStale(task, staleAfterMs)) {
      const updated: BackgroundTaskRecord = {
        ...task,
        status: "failed",
        finishedAt: task.finishedAt ?? Date.now(),
        summary: task.summary ?? `Background session became stale (no heartbeat for ${staleAfterMs}ms).`,
      };
      writeBackgroundTask(updated);
      if (!multiplexer?.keepPaneOnFinish) closeTmuxPane(updated.paneId);
      return updated;
    }
    return task;
  });
}

export function renderMultiplexerStatus(ctxCwd: string, multiplexer: PantheonConfig["multiplexer"] | undefined, tasks: BackgroundTaskRecord[], staleAfterMs = 20000): string {
  const windowName = getMultiplexerWindowName(ctxCwd, multiplexer);
  const liveTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const paneSummary = liveTasks.map((task) => `- ${task.id}: ${task.agent} [${isTaskStale(task, staleAfterMs) ? `${task.status}/stale` : task.status}] pane=${task.paneId ?? "(none)"} heartbeat=${formatAge(task.heartbeatAt)} watch=${task.watchCount ?? 0}${task.sessionKey ? ` session=${task.sessionKey}` : ""}`).join("\n") || "- (no active background tasks)";
  return [
    `tmux enabled: ${multiplexer?.tmux === true ? "yes" : "no"}`,
    `inside tmux: ${process.env.TMUX ? "yes" : "no"}`,
    `window: ${windowName}`,
    `layout: ${multiplexer?.layout ?? "main-vertical"}`,
    `reuseWindow: ${multiplexer?.reuseWindow === false ? "no" : "yes"}`,
    `projectScopedWindow: ${multiplexer?.projectScopedWindow === false ? "no" : "yes"}`,
    `focusOnSpawn: ${multiplexer?.focusOnSpawn === true ? "yes" : "no"}`,
    `staleAfterMs: ${staleAfterMs}`,
    `\nActive panes/tasks:\n${paneSummary}`,
  ].join("\n");
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
    heartbeatAt: Date.now(),
    summary: task.summary ?? "Cancelled by user",
  };
  fs.writeFileSync(task.resultPath, JSON.stringify(updated, null, 2));
  return updated;
}
