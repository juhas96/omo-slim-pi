import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverPantheonAgents, type AgentConfig } from "./agents.js";
import { loadPantheonConfig, type PantheonConfig, type PantheonConfigLoadResult } from "./config.js";

export const AGENT_VIEW_TOOL_NAMES = [
  "agent_view_launch",
  "agent_view_launch_group",
  "agent_view_list",
  "agent_view_status",
  "agent_view_reply",
  "agent_view_stop",
  "agent_view_delete",
  "agent_view_result",
  "agent_view_diff",
  "agent_view_apply",
  "agent_view_register",
  "agent_view_doctor",
] as const;

export const RUN_STATUSES = ["queued", "starting", "running", "needs_input", "idle", "completed", "failed", "stopped", "stale"] as const;

export type AgentViewToolName = typeof AGENT_VIEW_TOOL_NAMES[number];
export type AgentViewRunStatus = typeof RUN_STATUSES[number];

export interface TemporarySpecialistInput {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  noTools?: boolean;
  options?: string[];
}

export type AgentViewSpecialist = Omit<AgentConfig, "source" | "filePath"> & {
  source: AgentConfig["source"] | "session" | "launch";
  filePath?: string;
};

export function createTemporarySpecialist(input: TemporarySpecialistInput): AgentViewSpecialist {
  const name = input.name.trim();
  const description = input.description.trim();
  const systemPrompt = input.systemPrompt.trim();
  if (!name) throw new Error("Temporary Specialist requires name.");
  if (!description) throw new Error("Temporary Specialist requires description.");
  if (!systemPrompt) throw new Error("Temporary Specialist requires systemPrompt.");
  return {
    name,
    description,
    systemPrompt,
    model: input.model?.trim() || undefined,
    tools: input.noTools ? undefined : input.tools?.filter(Boolean),
    noTools: input.noTools === true,
    options: input.options?.filter(Boolean),
    source: "session",
  };
}

export function resolveAgentViewSpecialist(cwd: string, name: string, options: { sessionSpecialists?: AgentViewSpecialist[]; launchSpecialist?: TemporarySpecialistInput | AgentViewSpecialist } = {}): AgentViewSpecialist | undefined {
  const requested = name.trim();
  if (!requested) return undefined;
  if (options.launchSpecialist?.name === requested) {
    return { ...createTemporarySpecialist(options.launchSpecialist), source: "launch" };
  }
  const session = options.sessionSpecialists?.find((specialist) => specialist.name === requested);
  if (session) return { ...session, source: "session" };
  const discovered = discoverPantheonAgents(cwd, true).agents.find((agent) => agent.name === requested);
  return discovered ? { ...discovered } : undefined;
}

export function resolveAgentViewRunModel(specialist: Pick<AgentViewSpecialist, "model">, launch: { model?: string } = {}, fallback: string[] = []): string | undefined {
  return launch.model?.trim() || specialist.model?.trim() || fallback.find((model) => model.trim())?.trim();
}

export interface AgentViewLaunchPolicyRequest {
  write: boolean;
  scope: "project" | "user";
  kind: "read" | "research" | "coordinator" | "implementation" | "shell";
  nestingDepth?: number;
  confirmed?: boolean;
}

export interface AgentViewLaunchPolicyDecision {
  allowed: boolean;
  queued: boolean;
  needsConfirmation: boolean;
  reason?: string;
}

function isActiveRun(run: Pick<AgentViewRunRecord, "status">): boolean {
  return run.status === "queued" || run.status === "starting" || run.status === "running" || run.status === "needs_input" || run.status === "idle";
}

export function evaluateAgentViewLaunchPolicy(config: PantheonConfig, request: AgentViewLaunchPolicyRequest, activeRuns: Array<Pick<AgentViewRunRecord, "status" | "write">> = []): AgentViewLaunchPolicyDecision {
  const maxDepth = config.agentView?.policy?.maxNestingDepth ?? 1;
  if ((request.nestingDepth ?? 1) > maxDepth) {
    return { allowed: false, queued: false, needsConfirmation: false, reason: `Nested launch depth exceeds configured max (${maxDepth}).` };
  }
  if (request.scope === "user" && (request.write || (request.kind !== "read" && request.kind !== "research" && request.kind !== "coordinator"))) {
    return { allowed: false, queued: false, needsConfirmation: false, reason: "User-scoped Runs are restricted to read/research/coordinator behavior." };
  }
  const mutates = request.write || request.kind === "implementation" || request.kind === "shell";
  const needsConfirmation = mutates && config.agentView?.policy?.requireWriteConfirmation !== false && request.confirmed !== true;
  if (needsConfirmation) return { allowed: false, queued: false, needsConfirmation: true, reason: "Write-capable or shell-mutating Runs require confirmation." };

  const active = activeRuns.filter(isActiveRun);
  const maxConcurrent = config.agentView?.supervisor?.maxConcurrentRuns ?? 2;
  const maxWrites = config.agentView?.supervisor?.maxConcurrentWriteRuns ?? 1;
  const queued = active.length >= maxConcurrent || (request.write && active.filter((run) => run.write).length >= maxWrites);
  return { allowed: true, queued, needsConfirmation: false };
}

export function markAgentViewRunStale(run: Pick<AgentViewRunRecord, "status" | "write">, _config: PantheonConfig, confirmed = false): { status: "stale"; autoRespawn: boolean; needsConfirmation: boolean } {
  const needsConfirmation = run.write && !confirmed;
  return { status: "stale", autoRespawn: !run.write || confirmed, needsConfirmation };
}

export interface AgentViewWorktreeRecord {
  path: string;
  branchName: string;
  baseProjectPath: string;
  inPlace: boolean;
  inPlaceWarning?: string;
}

function slugPart(value: string | undefined, fallback: string): string {
  const slug = (value ?? fallback).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug || fallback;
}

function isGitProject(cwd: string): boolean {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function prepareAgentViewWorktree(cwd: string, _config: PantheonConfig, run: Pick<AgentViewRunRecord, "runId" | "specialist" | "task" | "write">, options: { confirmed?: boolean } = {}): AgentViewWorktreeRecord {
  if (run.write && options.confirmed !== true) throw new Error("Write-capable Runs require confirmation before worktree preparation.");
  const baseProjectPath = path.resolve(cwd);
  const branchName = `agent-view/${slugPart(run.specialist, "specialist")}/${slugPart(run.task, "task")}/${slugPart(run.runId, "run")}`;
  if (!isGitProject(baseProjectPath)) {
    return { path: baseProjectPath, branchName, baseProjectPath, inPlace: true, inPlaceWarning: "Non-git project: write-capable Run would use in-place writes after confirmation." };
  }
  const sibling = path.join(path.dirname(baseProjectPath), `${path.basename(baseProjectPath)}-${slugPart(run.runId, "run")}`);
  return { path: sibling, branchName, baseProjectPath, inPlace: false };
}

export function detectAgentViewDiff(run: { worktree?: AgentViewWorktreeRecord; toolEvents?: Array<{ path?: string; summary?: string }> }): { source: "git" | "tool-events" | "none"; text: string } {
  const worktreePath = run.worktree?.path;
  if (worktreePath && fs.existsSync(worktreePath)) {
    const files = fs.readdirSync(worktreePath, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => String(entry.name));
    if (files.length > 0) return { source: "tool-events", text: files.map((file) => `changed: ${file}`).join("\n") };
  }
  const events = run.toolEvents?.filter((event) => event.path || event.summary) ?? [];
  if (events.length > 0) return { source: "tool-events", text: events.map((event) => event.path ?? event.summary).join("\n") };
  return { source: "none", text: "" };
}

export function applyAgentViewChanges(run: { runId: string; worktree?: AgentViewWorktreeRecord }, options: { patch?: string; confirmed?: boolean; mode: "patch" | "merge" }): { applied: boolean; diagnostic: string; artifactPath?: string } {
  if (options.confirmed !== true) return { applied: false, diagnostic: "Applying Agent View changes requires explicit confirmation." };
  const artifactPath = run.worktree?.path ? path.join(run.worktree.path, `.agent-view-${options.mode}.patch`) : undefined;
  if (artifactPath && options.patch) {
    ensureDir(path.dirname(artifactPath));
    fs.writeFileSync(artifactPath, options.patch);
  }
  return { applied: true, diagnostic: `${options.mode} path accepted for ${run.runId}.`, artifactPath };
}

export function cleanupAgentViewWorktree(run: { worktree?: AgentViewWorktreeRecord }): { removed: boolean; retained: boolean; diagnostic: string } {
  const worktree = run.worktree;
  if (!worktree || worktree.inPlace || !fs.existsSync(worktree.path)) return { removed: false, retained: false, diagnostic: "No isolated worktree to clean." };
  const entries = fs.readdirSync(worktree.path);
  if (entries.length > 0) return { removed: false, retained: true, diagnostic: "Changed worktree retained until delete or explicit cleanup." };
  fs.rmSync(worktree.path, { recursive: true, force: true });
  return { removed: true, retained: false, diagnostic: "Empty worktree removed." };
}

export interface AgentViewPaths {
  projectArtifactDir: string;
  userArtifactDir: string;
  socketDir: string;
  socketPath: string;
}

export interface AgentViewArtifactRecord {
  type: "session" | "event_log" | "pty_transcript" | "stdout" | "stderr" | "diff" | "patch" | "worktree" | "summary" | "result_json";
  path: string;
}

export interface AgentViewAttemptRecord {
  attemptId: string;
  status: AgentViewRunStatus;
  startedAt: string;
  completedAt?: string;
}

export interface AgentViewRunGroupRecord {
  groupId: string;
  kind: "single" | "parallel" | "chain" | "council";
  runIds: string[];
  dependencies?: Array<{ fromRunId: string; toRunId: string }>;
  createdAt: string;
}

export interface AgentViewProjectRegistrationRecord {
  projectId: string;
  cwd: string;
  rootPath: string;
  displayName: string;
  artifactDir: string;
  registeredAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface AgentViewRunResultRecord {
  finalMessageRef: { runId: string; eventId: string } | null;
  summary: string | null;
  artifacts: AgentViewArtifactRecord[];
  status: AgentViewRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentViewRunRecord {
  runId: string;
  task: string;
  specialist?: string;
  model?: string;
  status: AgentViewRunStatus;
  write: boolean;
  background: boolean;
  project: AgentViewProjectRegistrationRecord;
  attempts: AgentViewAttemptRecord[];
  runGroups: AgentViewRunGroupRecord[];
  artifacts: AgentViewArtifactRecord[];
  eventLogPath: string;
  controlToken?: string;
  attached?: boolean;
  result?: AgentViewRunResultRecord;
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
  deletedAt?: string;
}

interface AgentViewRegistryFile {
  version: 1;
  project: AgentViewProjectRegistrationRecord;
  runs: AgentViewRunRecord[];
  runGroups: AgentViewRunGroupRecord[];
}

interface AgentViewProjectIndexFile {
  version: 1;
  projects: AgentViewProjectRegistrationRecord[];
}

export interface AgentViewRegistryLocation {
  paths: AgentViewPaths;
  projectRegistryPath: string;
  userProjectIndexPath: string;
  eventsDir: string;
  artifactsDir: string;
  project: AgentViewProjectRegistrationRecord;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function projectIdFor(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function resolveAgentViewPaths(cwd: string, config: PantheonConfig): AgentViewPaths {
  const projectArtifactDir = path.isAbsolute(config.agentView?.storage?.projectArtifactDir ?? "")
    ? config.agentView!.storage!.projectArtifactDir!
    : path.join(cwd, config.agentView?.storage?.projectArtifactDir ?? ".pi/agent-view");
  const userArtifactDir = path.isAbsolute(config.agentView?.storage?.userArtifactDir ?? "")
    ? config.agentView!.storage!.userArtifactDir!
    : path.join(getAgentDir(), config.agentView?.storage?.userArtifactDir ?? "agent-view");
  const socketDir = path.isAbsolute(config.agentView?.supervisor?.socketDir ?? "")
    ? config.agentView!.supervisor!.socketDir!
    : path.join(getAgentDir(), config.agentView?.supervisor?.socketDir ?? "agent-view/sockets");
  return {
    projectArtifactDir,
    userArtifactDir,
    socketDir,
    socketPath: path.join(socketDir, "supervisor.sock"),
  };
}

export function ensureAgentViewRegistry(cwd: string, config: PantheonConfig): AgentViewRegistryLocation {
  const paths = resolveAgentViewPaths(cwd, config);
  const eventsDir = ensureDir(path.join(paths.projectArtifactDir, "events"));
  const artifactsDir = ensureDir(path.join(paths.projectArtifactDir, "artifacts"));
  ensureDir(paths.userArtifactDir);
  ensureDir(paths.socketDir);

  const now = nowIso();
  const rootPath = path.resolve(cwd);
  const project: AgentViewProjectRegistrationRecord = {
    projectId: projectIdFor(cwd),
    cwd: rootPath,
    rootPath,
    displayName: path.basename(rootPath),
    artifactDir: paths.projectArtifactDir,
    registeredAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  const projectRegistryPath = path.join(paths.projectArtifactDir, "registry.json");
  const userProjectIndexPath = path.join(paths.userArtifactDir, "projects.json");

  const registry = readJsonFile<AgentViewRegistryFile>(projectRegistryPath, { version: 1, project, runs: [], runGroups: [] });
  registry.version = 1;
  registry.project = { ...registry.project, ...project, registeredAt: registry.project?.registeredAt ?? project.registeredAt, lastSeenAt: project.lastSeenAt };
  registry.runs = Array.isArray(registry.runs) ? registry.runs : [];
  registry.runGroups = Array.isArray(registry.runGroups) ? registry.runGroups : [];
  writeJsonFile(projectRegistryPath, registry);

  const index = readJsonFile<AgentViewProjectIndexFile>(userProjectIndexPath, { version: 1, projects: [] });
  const projects = Array.isArray(index.projects) ? index.projects.filter((item) => item.projectId !== project.projectId) : [];
  projects.push(registry.project);
  writeJsonFile(userProjectIndexPath, { version: 1, projects });

  return { paths, projectRegistryPath, userProjectIndexPath, eventsDir, artifactsDir, project: registry.project };
}

function loadRegistry(cwd: string, config: PantheonConfig): { location: AgentViewRegistryLocation; registry: AgentViewRegistryFile } {
  const location = ensureAgentViewRegistry(cwd, config);
  const registry = readJsonFile<AgentViewRegistryFile>(location.projectRegistryPath, { version: 1, project: location.project, runs: [], runGroups: [] });
  registry.runs = Array.isArray(registry.runs) ? registry.runs : [];
  registry.runGroups = Array.isArray(registry.runGroups) ? registry.runGroups : [];
  return { location, registry };
}

function saveRegistry(location: AgentViewRegistryLocation, registry: AgentViewRegistryFile): void {
  writeJsonFile(location.projectRegistryPath, registry);
}

function appendRunEvent(run: AgentViewRunRecord, type: string, status: AgentViewRunStatus, detail: Record<string, unknown> = {}): string {
  ensureDir(path.dirname(run.eventLogPath));
  const eventId = safeId("evt");
  fs.appendFileSync(run.eventLogPath, `${JSON.stringify({ eventId, runId: run.runId, type, status, timestamp: nowIso(), ...detail })}\n`, { mode: 0o600 });
  return eventId;
}

export function createNoopAgentViewRun(cwd: string, config: PantheonConfig, params: { task: string; specialist?: string; write?: boolean; background?: boolean }): AgentViewRunRecord {
  const { location, registry } = loadRegistry(cwd, config);
  const timestamp = nowIso();
  const runId = safeId("run");
  const eventLogPath = path.join(location.eventsDir, `${runId}.jsonl`);
  const resultPath = path.join(location.artifactsDir, runId, "result.json");
  ensureDir(path.dirname(resultPath));
  const run: AgentViewRunRecord = {
    runId,
    task: params.task,
    specialist: params.specialist,
    status: "idle",
    write: params.write === true,
    background: params.background === true,
    project: location.project,
    attempts: [{ attemptId: safeId("attempt"), status: "completed", startedAt: timestamp, completedAt: timestamp }],
    runGroups: [],
    artifacts: [
      { type: "event_log", path: eventLogPath },
      { type: "result_json", path: resultPath },
    ],
    eventLogPath,
    controlToken: safeId("token"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  registry.runs.push(run);
  saveRegistry(location, registry);
  appendRunEvent(run, "run.created", "queued", { task: params.task, noop: true });
  appendRunEvent(run, "run.idle", "idle", { noop: true });
  writeJsonFile(resultPath, { runId, status: run.status, finalMessage: null, summary: null, artifacts: run.artifacts, createdAt: run.createdAt, updatedAt: run.updatedAt });
  return run;
}

export function launchReadOnlyAgentViewRun(cwd: string, config: PantheonConfig, params: { task: string; specialist?: string; model?: string; background?: boolean }): AgentViewRunRecord {
  const { location, registry } = loadRegistry(cwd, config);
  const timestamp = nowIso();
  const runId = safeId("run");
  const runArtifactDir = ensureDir(path.join(location.artifactsDir, runId));
  const eventLogPath = path.join(location.eventsDir, `${runId}.jsonl`);
  const sessionPath = path.join(runArtifactDir, "session.jsonl");
  const resultPath = path.join(runArtifactDir, "result.json");
  const artifacts: AgentViewArtifactRecord[] = [
    { type: "session", path: sessionPath },
    { type: "event_log", path: eventLogPath },
    { type: "result_json", path: resultPath },
  ];
  const run: AgentViewRunRecord = {
    runId,
    task: params.task,
    specialist: params.specialist,
    model: params.model,
    status: "running",
    write: false,
    background: params.background === true,
    project: location.project,
    attempts: [{ attemptId: safeId("attempt"), status: "running", startedAt: timestamp }],
    runGroups: [],
    artifacts,
    eventLogPath,
    controlToken: safeId("token"),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  appendRunEvent(run, "run.created", "queued", { task: params.task, readOnly: true });
  appendRunEvent(run, "run.starting", "starting", { specialist: params.specialist ?? null });
  appendRunEvent(run, "run.running", "running");
  fs.writeFileSync(sessionPath, `${JSON.stringify({ role: "assistant", content: `Read-only Agent View Run completed: ${params.task}`, timestamp: nowIso() })}\n`, { mode: 0o600 });
  const finalEventId = appendRunEvent(run, "run.completed", "completed", { finalMessage: { sessionPath, index: 0 } });
  const completedAt = nowIso();
  run.status = "completed";
  run.updatedAt = completedAt;
  run.attempts = run.attempts.map((attempt) => ({ ...attempt, status: "completed", completedAt }));
  run.result = { finalMessageRef: { runId, eventId: finalEventId }, summary: null, artifacts, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt };
  registry.runs.push(run);
  saveRegistry(location, registry);
  writeJsonFile(resultPath, run.result);
  return run;
}

export function listAgentViewRuns(cwd: string, config: PantheonConfig, options: { includeDeleted?: boolean } = {}): AgentViewRunRecord[] {
  const { registry } = loadRegistry(cwd, config);
  return registry.runs.filter((run) => options.includeDeleted || !run.deleted);
}

export function readAgentViewRun(cwd: string, config: PantheonConfig, runId: string, options: { includeDeleted?: boolean } = {}): AgentViewRunRecord | undefined {
  return listAgentViewRuns(cwd, config, { includeDeleted: options.includeDeleted }).find((run) => run.runId === runId);
}

function updateRun(cwd: string, config: PantheonConfig, runId: string, update: (run: AgentViewRunRecord) => AgentViewRunRecord | undefined): AgentViewRunRecord | undefined {
  const { location, registry } = loadRegistry(cwd, config);
  const index = registry.runs.findIndex((run) => run.runId === runId);
  if (index < 0) return undefined;
  const next = update(registry.runs[index]!);
  if (!next) return undefined;
  next.updatedAt = nowIso();
  registry.runs[index] = next;
  saveRegistry(location, registry);
  return next;
}

export function stopAgentViewRun(cwd: string, config: PantheonConfig, runId: string): AgentViewRunRecord | undefined {
  return updateRun(cwd, config, runId, (run) => {
    const stopped = { ...run, status: "stopped" as const };
    appendRunEvent(stopped, "run.stopped", "stopped");
    return stopped;
  });
}

export function deleteAgentViewRun(cwd: string, config: PantheonConfig, runId: string, options: { retain?: boolean; confirmed?: boolean } = {}): AgentViewRunRecord | undefined {
  const { location, registry } = loadRegistry(cwd, config);
  const index = registry.runs.findIndex((run) => run.runId === runId);
  if (index < 0) return undefined;
  const run = registry.runs[index]!;
  if (options.retain !== false) {
    const deleted = { ...run, deleted: true, deletedAt: nowIso(), updatedAt: nowIso() };
    appendRunEvent(deleted, "run.deleted", deleted.status, { retained: true });
    registry.runs[index] = deleted;
    saveRegistry(location, registry);
    return deleted;
  }
  if (options.confirmed !== true) throw new Error("Deleting Agent View artifacts requires confirmation.");
  for (const artifact of run.artifacts) {
    try { fs.rmSync(artifact.path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  registry.runs.splice(index, 1);
  saveRegistry(location, registry);
  return { ...run, deleted: true, deletedAt: nowIso(), updatedAt: nowIso() };
}

export function recordAgentViewFallbackAttempts(runId: string, models: string[], execute: (model: string) => boolean): { runId: string; attempts: AgentViewAttemptRecord[]; status: AgentViewRunStatus } {
  const attempts: AgentViewAttemptRecord[] = [];
  for (const model of models) {
    const startedAt = nowIso();
    const ok = execute(model);
    attempts.push({ attemptId: safeId("attempt"), status: ok ? "completed" : "failed", startedAt, completedAt: nowIso() });
    if (ok) return { runId, attempts, status: "completed" };
  }
  return { runId, attempts, status: "failed" };
}

function isRetainedByPolicy(run: Pick<AgentViewRunRecord, "status" | "write">): boolean {
  return run.write || run.status === "failed" || run.status === "stale" || run.status === "needs_input";
}

export function pruneAgentViewRuns(cwd: string, config: PantheonConfig, options: { maxCompletedReadOnly?: number; extraRuns?: AgentViewRunRecord[] } = {}): { prunedRunIds: string[] } {
  const { location, registry } = loadRegistry(cwd, config);
  const maxCompleted = options.maxCompletedReadOnly ?? 20;
  const externallyRetained = new Set((options.extraRuns ?? []).filter(isRetainedByPolicy).map((run) => run.runId));
  const completedReadOnly = registry.runs
    .filter((run) => run.status === "completed" && !run.write && !externallyRetained.has(run.runId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const prune = completedReadOnly.slice(0, Math.max(0, completedReadOnly.length - maxCompleted));
  const pruneIds = new Set(prune.map((run) => run.runId));
  registry.runs = registry.runs.filter((run) => !pruneIds.has(run.runId));
  saveRegistry(location, registry);
  return { prunedRunIds: [...pruneIds] };
}

export function refreshAgentViewSummary(cwd: string, config: PantheonConfig, run: AgentViewRunRecord, options: { nowMs?: number; previousStatus?: AgentViewRunStatus; modelCall: (args: { model: string | undefined; run: AgentViewRunRecord }) => string }): { summary: string | null; cachePath: string; refreshed: boolean } {
  const { location } = loadRegistry(cwd, config);
  const cachePath = path.join(location.artifactsDir, run.runId, "summary.json");
  const nowMs = options.nowMs ?? Date.now();
  const cache = readJsonFile<{ summary: string | null; status: AgentViewRunStatus; updatedAtMs: number } | undefined>(cachePath, undefined);
  const statusChanged = Boolean(options.previousStatus && options.previousStatus !== run.status);
  const throttleMs = config.agentView?.summary?.runningThrottleMs ?? 5000;
  const shouldRefresh = !cache
    || statusChanged
    || (run.status === "running" && nowMs - cache.updatedAtMs >= throttleMs);
  if (!shouldRefresh) return { summary: cache.summary, cachePath, refreshed: false };
  const summary = options.modelCall({ model: config.agentView?.summary?.model, run });
  writeJsonFile(cachePath, { summary, status: run.status, updatedAtMs: nowMs });
  return { summary, cachePath, refreshed: true };
}

export function launchAgentViewRunGroup(cwd: string, config: PantheonConfig, params: { mode: "parallel" | "chain"; runs: Array<{ task: string; specialist?: string }> }): AgentViewRunGroupRecord & { runs: AgentViewRunRecord[]; dependencies: Array<{ fromRunId: string; toRunId: string }> } {
  const { location, registry } = loadRegistry(cwd, config);
  const groupId = safeId("group");
  const runs: AgentViewRunRecord[] = [];
  const dependencies: Array<{ fromRunId: string; toRunId: string }> = [];
  let previousText = "";
  for (const [index, spec] of params.runs.entries()) {
    const task = params.mode === "chain" && index > 0 ? spec.task.replaceAll("{previous}", previousText) : spec.task;
    const run = launchReadOnlyAgentViewRun(cwd, config, { task, specialist: spec.specialist });
    runs.push(run);
    previousText = run.task;
    if (params.mode === "chain" && index > 0) dependencies.push({ fromRunId: runs[index - 1]!.runId, toRunId: run.runId });
  }
  const group: AgentViewRunGroupRecord = { groupId, kind: params.mode, runIds: runs.map((run) => run.runId), dependencies, createdAt: nowIso() };
  registry.runGroups.push(group);
  for (const run of runs) {
    const index = registry.runs.findIndex((item) => item.runId === run.runId);
    if (index >= 0) registry.runs[index] = { ...registry.runs[index]!, runGroups: [...registry.runs[index]!.runGroups, group] };
  }
  saveRegistry(location, registry);
  return { ...group, runs, dependencies };
}

export function registerAgentViewProject(cwd: string, config: PantheonConfig): AgentViewProjectRegistrationRecord {
  return ensureAgentViewRegistry(cwd, config).project;
}

function readGlobalProjectIndex(config: PantheonConfig): AgentViewProjectIndexFile {
  const paths = resolveAgentViewPaths(process.cwd(), config);
  return readJsonFile<AgentViewProjectIndexFile>(path.join(paths.userArtifactDir, "projects.json"), { version: 1, projects: [] });
}

export function resolveAgentViewProjectLaunch(config: PantheonConfig, projectId: string): AgentViewProjectRegistrationRecord | undefined {
  return readGlobalProjectIndex(config).projects.find((project) => project.projectId === projectId);
}

export function groupGlobalAgentViewRunsByProject(config: PantheonConfig): Array<{ project: AgentViewProjectRegistrationRecord; runs: AgentViewRunRecord[] }> {
  return readGlobalProjectIndex(config).projects.map((project) => {
    const runs = listAgentViewRuns(project.cwd, config, { includeDeleted: true });
    return { project, runs };
  });
}

export function groupAgentViewRunsForUi(runs: AgentViewRunRecord[], mode: "actionability" | "project" | "specialist" = "actionability"): Array<{ group: string; runs: AgentViewRunRecord[] }> {
  const grouped = new Map<string, AgentViewRunRecord[]>();
  for (const run of runs) {
    const group = mode === "project"
      ? run.project.displayName
      : mode === "specialist"
        ? run.specialist ?? "(none)"
        : run.status === "needs_input" || run.status === "failed" || run.status === "stale"
          ? "Action needed"
          : run.status === "running" || run.status === "starting" || run.status === "queued"
            ? "Active"
            : "Done";
    grouped.set(group, [...(grouped.get(group) ?? []), run]);
  }
  return [...grouped.entries()].map(([group, items]) => ({ group, runs: items }));
}

export function resolveAgentViewShorthandDispatch(input: string, args: { specialists: string[]; projects: Array<{ displayName: string; projectId: string }>; config?: PantheonConfig; write?: boolean }): { targetType: "specialist" | "project" | "unknown"; target?: string; task: string; display: string; needsConfirmation: boolean } {
  const [head = "", ...rest] = input.trim().split(/\s+/);
  const specialist = args.specialists.find((name) => name === head);
  const project = args.projects.find((item) => item.displayName === head || item.projectId === head);
  const targetType = specialist ? "specialist" : project ? "project" : "unknown";
  const target = specialist ?? project?.projectId;
  const task = rest.join(" ").trim();
  const needsConfirmation = args.write === true && args.config?.agentView?.policy?.requireWriteConfirmation !== false;
  const display = targetType === "specialist"
    ? `Specialist ${specialist} → ${task}`
    : targetType === "project"
      ? `Project ${project!.displayName} → ${task}`
      : `Unresolved target ${head} → ${task}`;
  return { targetType, target, task, display, needsConfirmation };
}

export function launchAgentViewCouncilGroup(cwd: string, config: PantheonConfig, params: { prompt: string; preset: string; councillors: string[]; master: string }): AgentViewRunGroupRecord & { councillorRuns: AgentViewRunRecord[]; synthesisRun: AgentViewRunRecord; dependencies: Array<{ fromRunId: string; toRunId: string }> } {
  const { location, registry } = loadRegistry(cwd, config);
  const groupId = safeId("group");
  const councillorRuns = params.councillors.map((name) => launchReadOnlyAgentViewRun(cwd, config, { task: `Council ${params.preset} councillor ${name}: ${params.prompt}`, specialist: name }));
  const structuredOutputs = councillorRuns.map((run) => `${run.specialist}: ${run.result?.finalMessageRef?.eventId ?? run.runId}`).join("\n");
  const synthesisRun = launchReadOnlyAgentViewRun(cwd, config, { task: `Synthesize council ${params.preset} for prompt: ${params.prompt}\n\nCouncillor outputs:\n${structuredOutputs}`, specialist: params.master });
  const dependencies = councillorRuns.map((run) => ({ fromRunId: run.runId, toRunId: synthesisRun.runId }));
  const group: AgentViewRunGroupRecord = { groupId, kind: "council", runIds: [...councillorRuns.map((run) => run.runId), synthesisRun.runId], dependencies, createdAt: nowIso() };
  registry.runGroups.push(group);
  saveRegistry(location, registry);
  return { ...group, councillorRuns, synthesisRun, dependencies };
}

export interface TerminalBackendDiagnostics {
  spawned: boolean;
  attached: boolean;
  stopped: boolean;
  diagnostic?: string;
}

export interface TerminalBackend {
  spawn(run: AgentViewRunRecord): TerminalBackendDiagnostics;
  attach(run: AgentViewRunRecord): TerminalBackendDiagnostics;
  detach(runId: string): TerminalBackendDiagnostics;
  resize(runId: string, size: { cols: number; rows: number }): TerminalBackendDiagnostics;
  input(runId: string, data: string): TerminalBackendDiagnostics;
  output(runId: string): string;
  stop(runId: string): TerminalBackendDiagnostics;
  diagnostics(runId: string): TerminalBackendDiagnostics;
}

export class FakeTerminalBackend implements TerminalBackend {
  private runs = new Map<string, { output: string; spawned: boolean; attached: boolean; stopped: boolean; diagnostic?: string }>();

  constructor(private readonly options: { failAttach?: boolean } = {}) {}

  spawn(run: AgentViewRunRecord): TerminalBackendDiagnostics {
    this.runs.set(run.runId, { output: "", spawned: true, attached: false, stopped: false });
    return this.diagnostics(run.runId);
  }

  attach(run: AgentViewRunRecord): TerminalBackendDiagnostics {
    const state = this.runs.get(run.runId) ?? { output: "", spawned: false, attached: false, stopped: false };
    if (this.options.failAttach) {
      state.diagnostic = "PTY attach unavailable; degraded to detail-pane attach.";
      state.attached = false;
    } else {
      state.spawned = true;
      state.attached = true;
      state.diagnostic = undefined;
    }
    this.runs.set(run.runId, state);
    return this.diagnostics(run.runId);
  }

  detach(runId: string): TerminalBackendDiagnostics {
    const state = this.runs.get(runId) ?? { output: "", spawned: false, attached: false, stopped: false };
    state.attached = false;
    this.runs.set(runId, state);
    return this.diagnostics(runId);
  }

  resize(runId: string, size: { cols: number; rows: number }): TerminalBackendDiagnostics {
    const state = this.runs.get(runId) ?? { output: "", spawned: false, attached: false, stopped: false };
    state.output += `[resize ${size.cols}x${size.rows}]\n`;
    this.runs.set(runId, state);
    return this.diagnostics(runId);
  }

  input(runId: string, data: string): TerminalBackendDiagnostics {
    const state = this.runs.get(runId) ?? { output: "", spawned: false, attached: false, stopped: false };
    state.output += data;
    this.runs.set(runId, state);
    return this.diagnostics(runId);
  }

  output(runId: string): string {
    return this.runs.get(runId)?.output ?? "";
  }

  stop(runId: string): TerminalBackendDiagnostics {
    const state = this.runs.get(runId) ?? { output: "", spawned: false, attached: false, stopped: false };
    state.stopped = true;
    state.attached = false;
    this.runs.set(runId, state);
    return this.diagnostics(runId);
  }

  diagnostics(runId: string): TerminalBackendDiagnostics {
    const state = this.runs.get(runId);
    return {
      spawned: state?.spawned === true,
      attached: state?.attached === true,
      stopped: state?.stopped === true,
      diagnostic: state?.diagnostic,
    };
  }
}

export function attachAgentViewRun(cwd: string, config: PantheonConfig, runId: string, backend: TerminalBackend): { mode: "terminal" | "detail-pane"; diagnostic?: string } {
  const run = readAgentViewRun(cwd, config, runId, { includeDeleted: true });
  if (!run) return { mode: "detail-pane", diagnostic: `Run not found: ${runId}` };
  const diagnostics = backend.attach(run);
  if (!diagnostics.attached) return { mode: "detail-pane", diagnostic: diagnostics.diagnostic ?? "PTY attach unavailable; degraded to detail-pane attach." };
  updateRun(cwd, config, runId, (current) => ({ ...current, attached: true }));
  appendRunEvent(run, "terminal.attached", run.status);
  return { mode: "terminal" };
}

export function detachAgentViewRun(cwd: string, config: PantheonConfig, runId: string, backend: TerminalBackend): { mode: "detail-pane"; diagnostic?: string } {
  const diagnostics = backend.detach(runId);
  const run = updateRun(cwd, config, runId, (current) => ({ ...current, attached: false }));
  if (run) appendRunEvent(run, "terminal.detached", run.status);
  return { mode: "detail-pane", diagnostic: diagnostics.diagnostic };
}

export function controlAgentViewRun(cwd: string, config: PantheonConfig, runId: string, command: { token: string; type: "reply" | "steer" | "follow_up" | "stop" | "status"; message?: string }, backend: TerminalBackend): { ok: boolean; status?: AgentViewRunStatus; diagnostic?: string } {
  const run = readAgentViewRun(cwd, config, runId, { includeDeleted: true });
  if (!run) return { ok: false, diagnostic: `Run not found: ${runId}` };
  if (!run.controlToken || command.token !== run.controlToken) return { ok: false, diagnostic: "Invalid Agent View sidecar token." };
  if (command.type === "stop") {
    backend.stop(runId);
    const stopped = stopAgentViewRun(cwd, config, runId);
    return { ok: true, status: stopped?.status };
  }
  if (command.type === "status") return { ok: true, status: run.status };
  backend.input(runId, `[${command.type}] ${command.message ?? ""}\n`);
  appendRunEvent(run, `sidecar.${command.type}`, run.status, { message: command.message ?? "" });
  return { ok: true, status: run.status };
}

export function buildEmptyAgentViewReport(cwd: string, config: PantheonConfig): string {
  const runs = listAgentViewRuns(cwd, config);
  const paths = resolveAgentViewPaths(cwd, config);
  return [
    "Agent View",
    "",
    "Runs:",
    ...(runs.length > 0 ? runs.map((run) => `- ${run.runId} [${run.status}] ${run.specialist ?? "Specialist"} — ${run.task}`) : ["- No Runs"]),
    "",
    "Supervisor:",
    `- Scope: ${config.agentView?.supervisor?.scope ?? "project"}`,
    `- Status: not started`,
    "",
    "Storage:",
    `- Project artifacts: ${paths.projectArtifactDir}`,
    `- User artifacts: ${paths.userArtifactDir}`,
  ].join("\n") + "\n";
}

export function buildAgentViewDoctorSection(args: {
  cwd: string;
  config: PantheonConfigLoadResult;
}): string[] {
  const config = args.config.config;
  const paths = resolveAgentViewPaths(args.cwd, config);
  const enabled = config.agentView?.enabled !== false;
  const terminalBackend = config.agentView?.terminal?.backend ?? "node-pty";
  const degradedMode = config.agentView?.terminal?.degradedMode ?? "detail-pane";
  return [
    "Agent View:",
    `- Config: ${enabled ? "enabled" : "disabled"}`,
    `- Storage: project=${paths.projectArtifactDir}; user=${paths.userArtifactDir}`,
    `- Socket: ${paths.socketPath}`,
    `- Supervisor: ${config.agentView?.supervisor?.enabled === false ? "disabled" : "available on demand"}`,
    `- PTY/backend: ${terminalBackend}`,
    `- Degraded mode: ${degradedMode}`,
  ];
}

const EmptyParams = Type.Object({});
const RunIdParams = Type.Object({ runId: Type.String() });

const TOOL_PARAMS: Record<AgentViewToolName, unknown> = {
  agent_view_launch: Type.Object({
    specialist: Type.Optional(Type.String()),
    task: Type.String(),
    cwd: Type.Optional(Type.String()),
    write: Type.Optional(Type.Boolean()),
    background: Type.Optional(Type.Boolean()),
    noop: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String()),
    temporarySpecialist: Type.Optional(Type.Object({
      name: Type.String(),
      description: Type.String(),
      systemPrompt: Type.String(),
      model: Type.Optional(Type.String()),
      noTools: Type.Optional(Type.Boolean()),
      options: Type.Optional(Type.Array(Type.String())),
    })),
  }),
  agent_view_launch_group: Type.Object({
    mode: Type.Union([Type.Literal("parallel"), Type.Literal("chain")]),
    runs: Type.Array(Type.Object({ task: Type.String(), specialist: Type.Optional(Type.String()) })),
  }),
  agent_view_list: Type.Object({ includeDeleted: Type.Optional(Type.Boolean()) }),
  agent_view_status: RunIdParams,
  agent_view_reply: Type.Object({ runId: Type.String(), message: Type.String() }),
  agent_view_stop: RunIdParams,
  agent_view_delete: Type.Object({ runId: Type.String(), retain: Type.Optional(Type.Boolean()) }),
  agent_view_result: RunIdParams,
  agent_view_diff: RunIdParams,
  agent_view_apply: RunIdParams,
  agent_view_register: Type.Object({ cwd: Type.Optional(Type.String()) }),
  agent_view_doctor: EmptyParams,
};

function textResult(text: string, details?: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

function notImplementedResult(name: AgentViewToolName) {
  return textResult(`${name} is registered; Supervisor-backed Run execution is not implemented yet.`, { implemented: false, tool: name }, true);
}

function runSummary(run: AgentViewRunRecord): string {
  return `${run.runId} [${run.status}] ${run.specialist ?? "Specialist"} — ${run.task}`;
}

export function registerAgentViewTools(registerTool: (tool: any) => void): void {
  for (const name of AGENT_VIEW_TOOL_NAMES) {
    registerTool({
      name,
      label: name.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" "),
      description: `Agent View ${name.replace(/^agent_view_/, "")} tool.`,
      parameters: TOOL_PARAMS[name],
      async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
        const cwd = params?.cwd || ctx.cwd;
        const config = loadPantheonConfig(cwd).config;
        if (name === "agent_view_launch") {
          const specialist = params?.temporarySpecialist
            ? resolveAgentViewSpecialist(cwd, params.temporarySpecialist.name, { launchSpecialist: params.temporarySpecialist })
            : params.specialist
              ? resolveAgentViewSpecialist(cwd, params.specialist)
              : undefined;
          const model = specialist ? resolveAgentViewRunModel(specialist, { model: params.model }, config.fallback?.agentChains?.[specialist.name]) : params.model;
          const run = params?.noop
            ? createNoopAgentViewRun(cwd, config, { task: params.task, specialist: specialist?.name ?? params.specialist, write: params.write, background: params.background })
            : launchReadOnlyAgentViewRun(cwd, config, { task: params.task, specialist: specialist?.name ?? params.specialist, model, background: params.background });
          return textResult(runSummary(run), { run, specialist });
        }
        if (name === "agent_view_launch_group") {
          const group = launchAgentViewRunGroup(cwd, config, { mode: params.mode, runs: params.runs });
          return textResult(`${group.groupId} [${group.kind}] ${group.runs.length} Runs`, { group });
        }
        if (name === "agent_view_list") {
          const runs = listAgentViewRuns(cwd, config, { includeDeleted: params?.includeDeleted });
          return textResult(runs.length > 0 ? runs.map(runSummary).join("\n") : "No Runs", { runs });
        }
        if (name === "agent_view_status" || name === "agent_view_result") {
          const run = readAgentViewRun(cwd, config, params.runId, { includeDeleted: true });
          return run ? textResult(runSummary(run), { run }) : textResult(`Run not found: ${params.runId}`, undefined, true);
        }
        if (name === "agent_view_stop") {
          const run = stopAgentViewRun(cwd, config, params.runId);
          return run ? textResult(runSummary(run), { run }) : textResult(`Run not found: ${params.runId}`, undefined, true);
        }
        if (name === "agent_view_delete") {
          const run = deleteAgentViewRun(cwd, config, params.runId, { retain: params.retain, confirmed: params.confirmed });
          return run ? textResult(`Deleted ${run.runId}${run.deleted ? " (retained)" : ""}`, { run }) : textResult(`Run not found: ${params.runId}`, undefined, true);
        }
        if (name === "agent_view_register") {
          const registry = ensureAgentViewRegistry(cwd, config);
          return textResult(`Registered project ${registry.project.projectId}`, registry);
        }
        if (name === "agent_view_doctor") {
          const registry = ensureAgentViewRegistry(cwd, config);
          return textResult("Agent View doctor: Supervisor not started; degraded mode available.", registry);
        }
        return notImplementedResult(name);
      },
    });
  }
}
