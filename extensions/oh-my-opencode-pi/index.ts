import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type AgentConfig,
  discoverPantheonAgents,
  loadOrchestratorPrompt,
} from "./agents.js";
import {
  type CouncilMemberConfig,
  type PantheonConfig,
  listConfigPresetNames,
  listCouncilPresetNames,
  loadPantheonConfig,
  resolveAgentAdapterPolicy,
  resolveCouncilPreset,
} from "./config.js";
import {
  attachBackgroundTaskPane,
  cancelBackgroundTask,
  cleanupBackgroundArtifacts,
  closeTmuxPane,
  getBackgroundStatusCounts,
  launchBackgroundTask,
  listBackgroundTasks,
  maybeStartQueuedTasks,
  readBackgroundTaskSpec,
  reconcileBackgroundTasks,
  renderBackgroundOverview,
  retryBackgroundTask,
  summarizeBackgroundCounts,
  tailLog,
} from "./background.js";
import {
  getFallbackModels,
  resolveCouncilAttemptTimeoutMs,
  resolveDelegateAttemptTimeoutMs,
} from "./hooks/fallback.js";
import { rescueEditSequence } from "./hooks/json-recovery.js";
import {
  AstGrepReplaceParams,
  AstGrepSearchParams,
  astGrepReplace,
  astGrepSearch,
} from "./tools/ast-grep.js";
import {
  LspDiagnosticsParams,
  LspPositionParams,
  LspReferencesParams,
  LspRenameParams,
  findReferences,
  getDiagnostics,
  gotoDefinition,
  renameSymbol,
} from "./tools/lsp.js";
import { RepoMapParams, buildRepoMap } from "./tools/cartography.js";
import type { BackgroundTaskRecord, BackgroundTaskSpec, SingleResult } from "./types.js";

interface DelegateDetails {
  mode: "single" | "parallel" | "chain";
  includeProjectAgents: boolean;
  results: SingleResult[];
}

interface CouncilRunResult {
  preset: string;
  master: SingleResult;
  councillors: Array<SingleResult & { memberName: string }>;
}

interface WorkflowState {
  updatedAt: number;
  uncheckedTodos: string[];
  lastAgentSummary?: string;
  recentBackgroundTaskIds?: string[];
}

interface DebugTraceContext {
  id: string;
  kind: string;
  dir: string;
  eventsPath: string;
  summaryPath: string;
}

interface SubagentDebugContext {
  traceId: string;
  label: string;
  dir: string;
  stdoutPath: string;
  stderrPath: string;
  summaryPath: string;
}

type RenderTheme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const SUBAGENT_ENV = "OH_MY_OPENCODE_PI_SUBAGENT";
const DEPTH_ENV = "OH_MY_OPENCODE_PI_DEPTH";
const AGENT_ENV = "OH_MY_OPENCODE_PI_AGENT";
const CONFIG_WARNING_KEY = "oh-my-opencode-pi-config-warning";
const TASK_STATUS_KEY = "oh-my-opencode-pi-task-status";
const AUTO_CONTINUE_KEY = "oh-my-opencode-pi-auto-continue";
const WORKFLOW_GUIDANCE_KEY = "oh-my-opencode-pi-workflow-guidance";

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function summarizeResult(result: SingleResult): string {
  const output = getFinalOutput(result.messages).trim();
  if (output) return output;
  if (result.errorMessage) return result.errorMessage;
  if (result.stderr.trim()) return result.stderr.trim();
  return "(no output)";
}

function hasMeaningfulResult(result: SingleResult): boolean {
  return getFinalOutput(result.messages).trim().length > 0;
}

function extractTextFromMessage(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function countUncheckedTodos(text: string): number {
  const matches = text.match(/^\s*[-*]\s+\[\s\]\s+/gm);
  return matches ? matches.length : 0;
}

function hasUncheckedTodos(text: string): boolean {
  return countUncheckedTodos(text) > 0;
}

function buildInterviewSpec(title: string, data: {
  objective: string;
  users: string;
  constraints: string;
  success: string;
  notes: string;
}): string {
  return `# ${title}\n\n## Objective\n${data.objective}\n\n## Users / Stakeholders\n${data.users}\n\n## Constraints\n${data.constraints}\n\n## Success Criteria\n${data.success}\n\n## Notes\n${data.notes || "-"}\n`;
}

function extractUncheckedTodoItems(text: string): string[] {
  return [...text.matchAll(/^\s*[-*]\s+\[\s\]\s+(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
}

function resolveWorkflowStatePath(cwd: string, config: PantheonConfig): string {
  const configured = config.workflow?.stateFile?.trim() || ".oh-my-opencode-pi-workflow.json";
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

function readWorkflowState(cwd: string, config: PantheonConfig): WorkflowState {
  const filePath = resolveWorkflowStatePath(cwd, config);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkflowState>;
    return {
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      uncheckedTodos: Array.isArray(parsed.uncheckedTodos) ? parsed.uncheckedTodos.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
      lastAgentSummary: typeof parsed.lastAgentSummary === "string" ? parsed.lastAgentSummary : undefined,
      recentBackgroundTaskIds: Array.isArray(parsed.recentBackgroundTaskIds) ? parsed.recentBackgroundTaskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    };
  } catch {
    return { updatedAt: 0, uncheckedTodos: [], recentBackgroundTaskIds: [] };
  }
}

function writeWorkflowState(cwd: string, config: PantheonConfig, state: WorkflowState): WorkflowState {
  const filePath = resolveWorkflowStatePath(cwd, config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized: WorkflowState = {
    updatedAt: state.updatedAt || Date.now(),
    uncheckedTodos: state.uncheckedTodos.filter((item) => item.trim().length > 0),
    lastAgentSummary: state.lastAgentSummary?.trim() || undefined,
    recentBackgroundTaskIds: (state.recentBackgroundTaskIds ?? []).filter((item, index, array) => item.trim().length > 0 && array.indexOf(item) === index).slice(-20),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function updateWorkflowState(cwd: string, config: PantheonConfig, mutate: (state: WorkflowState) => WorkflowState): WorkflowState {
  const current = readWorkflowState(cwd, config);
  const next = mutate(current);
  next.updatedAt = Date.now();
  return writeWorkflowState(cwd, config, next);
}

function renderWorkflowState(state: WorkflowState): string {
  const sections = [
    `Updated: ${state.updatedAt ? new Date(state.updatedAt).toISOString() : "(never)"}`,
    state.uncheckedTodos.length > 0 ? `\nUnchecked todos:\n${state.uncheckedTodos.map((item) => `- [ ] ${item}`).join("\n")}` : "\nUnchecked todos:\n(none)",
    state.lastAgentSummary ? `\nLast agent summary:\n${state.lastAgentSummary}` : undefined,
    state.recentBackgroundTaskIds && state.recentBackgroundTaskIds.length > 0 ? `\nRecent background task ids:\n${state.recentBackgroundTaskIds.map((item) => `- ${item}`).join("\n")}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return sections.join("\n");
}

function buildResumeContext(state: WorkflowState, tasks: BackgroundTaskRecord[], options?: {
  maxTasks?: number;
  includeCompletedBackground?: boolean;
  includeFailedBackground?: boolean;
}): string {
  const maxTasks = Math.max(1, Math.floor(options?.maxTasks ?? 6));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const prioritized = (state.recentBackgroundTaskIds ?? [])
    .map((id) => taskById.get(id))
    .filter((task): task is BackgroundTaskRecord => Boolean(task))
    .filter((task) => {
      if (task.status === "completed") return options?.includeCompletedBackground !== false;
      if (task.status === "failed" || task.status === "cancelled") return options?.includeFailedBackground !== false;
      return true;
    });

  const selectedTasks = prioritized.slice(0, maxTasks);
  const taskLines = selectedTasks.length > 0
    ? selectedTasks.map((task) => `- ${task.id} [${task.status}] ${task.agent}: ${task.summary ?? previewText(task.task, 120)}`).join("\n")
    : "- (no recent background tasks selected)";

  return [
    "Pantheon resume context:",
    state.uncheckedTodos.length > 0 ? `\nPersisted unchecked todos:\n${state.uncheckedTodos.map((item) => `- [ ] ${item}`).join("\n")}` : "\nPersisted unchecked todos:\n- (none)",
    state.lastAgentSummary ? `\nLast agent summary:\n${state.lastAgentSummary}` : undefined,
    `\nRelevant background tasks:\n${taskLines}`,
    "\nSuggested next step: reconcile remaining todos with completed/failed background work before launching duplicate tasks.",
  ].filter((item): item is string => Boolean(item)).join("\n");
}

function buildPantheonDashboardLines(
  ctx: ExtensionContext,
  config: PantheonConfig,
  state: WorkflowState,
  tasks: BackgroundTaskRecord[],
  autoContinueEnabled: boolean,
  configWarnings: number,
): string[] {
  const counts = getBackgroundStatusCounts(tasks);
  const activeTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const maxTodos = Math.max(1, config.ui?.maxTodos ?? 3);
  const maxBackgroundTasks = Math.max(1, config.ui?.maxBackgroundTasks ?? 3);
  const lines: string[] = [];

  const chips = [
    themeAccent(ctx, "Pantheon"),
    counts.running > 0 ? ctx.ui.theme.fg("warning", `${counts.running} running`) : undefined,
    counts.queued > 0 ? ctx.ui.theme.fg("muted", `${counts.queued} queued`) : undefined,
    counts.failed + counts.cancelled > 0 ? ctx.ui.theme.fg("error", `${counts.failed + counts.cancelled} trouble`) : undefined,
    state.uncheckedTodos.length > 0 ? ctx.ui.theme.fg("accent", `${state.uncheckedTodos.length} todos`) : undefined,
    autoContinueEnabled ? ctx.ui.theme.fg("success", "auto on") : ctx.ui.theme.fg("dim", "auto off"),
    configWarnings > 0 ? ctx.ui.theme.fg("warning", `${configWarnings} warning${configWarnings === 1 ? "" : "s"}`) : undefined,
  ].filter((item): item is string => Boolean(item));
  if (chips.length > 0) lines.push(chips.join(ctx.ui.theme.fg("dim", " • ")));

  for (const task of activeTasks.slice(0, maxBackgroundTasks)) {
    lines.push(`${getTaskStateChip(task.status, { fg: ctx.ui.theme.fg.bind(ctx.ui.theme), bold: ctx.ui.theme.bold.bind(ctx.ui.theme) })} ${ctx.ui.theme.fg("accent", task.agent)} ${ctx.ui.theme.fg("dim", task.id)} ${ctx.ui.theme.fg("muted", previewText(task.summary ?? task.task, 70))}`);
  }
  if (activeTasks.length > maxBackgroundTasks) {
    lines.push(ctx.ui.theme.fg("dim", `… +${activeTasks.length - maxBackgroundTasks} more active background task${activeTasks.length - maxBackgroundTasks === 1 ? "" : "s"}`));
  }

  for (const todo of state.uncheckedTodos.slice(0, maxTodos)) {
    lines.push(`${ctx.ui.theme.fg("muted", "☐")} ${previewText(todo, 96)}`);
  }
  if (state.uncheckedTodos.length > maxTodos) {
    lines.push(ctx.ui.theme.fg("dim", `… +${state.uncheckedTodos.length - maxTodos} more persisted todo${state.uncheckedTodos.length - maxTodos === 1 ? "" : "s"}`));
  }

  return lines;
}

function themeAccent(ctx: ExtensionContext, text: string): string {
  return ctx.ui.theme.fg("accent", ctx.ui.theme.bold(text));
}

function taskLooksMultiStep(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\b(and|then|also|plus|along with|end-to-end|migration|roadmap|plan|audit|refactor|overhaul)\b/.test(lower)
    || /\b\d+\.|\n-\s|\n\*\s/.test(prompt)
    || prompt.length > 260;
}

function buildWorkflowHints(prompt: string, config: PantheonConfig, activeBackgroundTasks: number, state?: WorkflowState): string {
  const lower = prompt.toLowerCase();
  const hints: string[] = [];

  if ((config.workflow?.phaseReminders ?? true) && taskLooksMultiStep(prompt)) {
    if (/\b(debug|bug|failure|flaky|error|regression)\b/.test(lower)) {
      hints.push("Phase reminder: reproduce → isolate → fix → verify.");
    } else if (/\b(refactor|migration|rewrite|overhaul)\b/.test(lower)) {
      hints.push("Phase reminder: map current state → plan bounded changes → implement incrementally → verify.");
    } else {
      hints.push("Phase reminder: scout → plan → implement → verify.");
    }
  }

  if (/\b(doc|docs|documentation|api|sdk|library|version|changelog|official|readme)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `librarian` when library or API behavior matters.");
  }
  if (/\b(find|where|which file|entrypoint|trace|search|locate|recon|explore|map the codebase)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `explorer` for reconnaissance before opening many files yourself.");
  }
  if (/\b(ui|ux|design|css|layout|responsive|accessibility|a11y|animation|visual)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `designer` for user-facing polish or frontend ergonomics.");
  }
  if (/\b(architecture|trade-?off|should we|security|risky|ambiguous|decision|review|debug)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `oracle` or `pantheon_council` when the task is high-stakes or ambiguous.");
  }
  if (/\b(implement|change|edit|patch|refactor|fix|add tests|write tests|ship)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `fixer` for bounded implementation-heavy work after requirements are clear.");
  }
  if (taskLooksMultiStep(prompt)) {
    hints.push("Break complex work into explicit todos and parallelize independent research or implementation when safe.");
    if (!(config.autoContinue?.enabled ?? false)) {
      hints.push("If you create a multi-step todo list, consider enabling auto-continue with `/pantheon-auto-continue on` or `pantheon_auto_continue`.");
    }
  }
  if ((config.workflow?.backgroundAwareness ?? true) && activeBackgroundTasks > 0) {
    hints.push(`There ${activeBackgroundTasks === 1 ? "is" : "are"} ${activeBackgroundTasks} active Pantheon background task${activeBackgroundTasks === 1 ? "" : "s"}; check ` + "`pantheon_background_status` before duplicating work.");
  }
  if ((state?.uncheckedTodos.length ?? 0) > 0) {
    hints.push(`There ${state!.uncheckedTodos.length === 1 ? "is" : "are"} ${state!.uncheckedTodos.length} persisted unchecked todo${state!.uncheckedTodos.length === 1 ? "" : "s"} from earlier work; reconcile them before starting duplicate work.`);
  }

  const uniqueHints = hints.filter((hint, index) => hints.indexOf(hint) === index);
  if (uniqueHints.length === 0) return "";
  return `\n\n<PantheonWorkflowHints>\n${uniqueHints.map((hint) => `- ${hint}`).join("\n")}\n</PantheonWorkflowHints>`;
}

function previewText(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function getResultState(result: SingleResult): { icon: string; color: "success" | "warning" | "error" } {
  if (result.exitCode === -1) return { icon: "…", color: "warning" };
  if (result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted") {
    return { icon: "✓", color: "success" };
  }
  return { icon: "✗", color: "error" };
}

function formatResultLine(result: SingleResult, theme: RenderTheme, maxPreview = 120): string {
  const state = getResultState(result);
  const model = result.model ? theme.fg("muted", ` (${previewText(result.model, 28)})`) : "";
  const source = result.agentSource !== "unknown" ? theme.fg("dim", ` [${result.agentSource}]`) : "";
  const reason = result.abortReason
    ? theme.fg("warning", ` aborted:${previewText(result.abortReason, 32)}`)
    : result.stopReason === "aborted"
      ? theme.fg("warning", " aborted")
      : result.stopReason === "error"
        ? theme.fg("error", " error")
        : "";
  return `${theme.fg(state.color, state.icon)} ${theme.fg("accent", `${result.agent}${result.step ? ` #${result.step}` : ""}`)}${model}${source}${reason} ${theme.fg("muted", "—")} ${previewText(summarizeResult(result), maxPreview)}`;
}

function summarizeResultStates(results: SingleResult[], theme: RenderTheme): string {
  const successful = results.filter((result) => getResultState(result).color === "success").length;
  const running = results.filter((result) => getResultState(result).color === "warning").length;
  const failed = results.filter((result) => getResultState(result).color === "error").length;
  return [
    theme.fg("success", `${successful} ok`),
    running > 0 ? theme.fg("warning", `${running} running`) : undefined,
    failed > 0 ? theme.fg("error", `${failed} failed`) : undefined,
  ].filter((item): item is string => Boolean(item)).join(theme.fg("dim", " • "));
}

function renderDelegateCall(args: {
  agent?: string;
  task?: string;
  tasks?: Array<{ agent: string; task: string }>;
  chain?: Array<{ agent: string; task: string }>;
}, theme: RenderTheme) {
  if (args.chain?.length) {
    const lines = [
      `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", `chain (${args.chain.length})`)}`,
      ...args.chain.slice(0, 5).map((step, index) => `  ${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("muted", previewText(step.task, 72))}`),
    ];
    if (args.chain.length > 5) lines.push(`  ${theme.fg("muted", `… +${args.chain.length - 5} more`)}`);
    return new Text(lines.join("\n"), 0, 0);
  }

  if (args.tasks?.length) {
    const lines = [
      `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", `parallel (${args.tasks.length})`)}`,
      ...args.tasks.slice(0, 5).map((task) => `  ${theme.fg("muted", "•")} ${theme.fg("accent", task.agent)} ${theme.fg("muted", previewText(task.task, 72))}`),
    ];
    if (args.tasks.length > 5) lines.push(`  ${theme.fg("muted", `… +${args.tasks.length - 5} more`)}`);
    return new Text(lines.join("\n"), 0, 0);
  }

  return new Text(
    `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", args.agent || "specialist")}\n  ${theme.fg("muted", previewText(args.task || "", 90))}`,
    0,
    0,
  );
}

function renderDelegateResult(
  result: { content: Array<{ type: string; text?: string }>; details?: DelegateDetails },
  expanded: boolean,
  theme: RenderTheme,
) {
  const details = result.details;
  if (!details || details.results.length === 0) {
    const text = result.content[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
    return new Text(text, 0, 0);
  }

  const lines = [
    `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", `${details.mode}`)}`,
    summarizeResultStates(details.results, theme),
  ];

  const results = expanded ? details.results : details.results.slice(0, 6);
  for (const item of results) lines.push(formatResultLine(item, theme, expanded ? 180 : 110));
  if (!expanded && details.results.length > results.length) {
    lines.push(theme.fg("muted", `… +${details.results.length - results.length} more (expand to view all)`));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function renderCouncilCall(
  args: { prompt: string; preset?: string },
  theme: RenderTheme,
) {
  const preset = args.preset ?? "default";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("pantheon_council"))} ${theme.fg("accent", preset)}\n  ${theme.fg("muted", previewText(args.prompt, 110))}`,
    0,
    0,
  );
}

function renderCouncilResult(
  result: { content: Array<{ type: string; text?: string }>; details?: CouncilRunResult },
  expanded: boolean,
  theme: RenderTheme,
) {
  const details = result.details;
  if (!details) {
    const text = result.content[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
    return new Text(text, 0, 0);
  }

  const lines = [
    `${theme.fg("toolTitle", theme.bold("pantheon_council"))} ${theme.fg("accent", details.preset)}`,
    summarizeResultStates([...details.councillors, details.master], theme),
    ...details.councillors.map((c) => formatResultLine({ ...c, agent: c.memberName }, theme, expanded ? 180 : 90)),
    formatResultLine({ ...details.master, agent: "master" }, theme, expanded ? 220 : 110),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

function isSuccessfulResult(result: SingleResult, options?: { allowEmpty?: boolean }): boolean {
  return result.exitCode === 0
    && result.stopReason !== "error"
    && result.stopReason !== "aborted"
    && (options?.allowEmpty === true || hasMeaningfulResult(result));
}

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeDebugName(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "trace";
}

function resolveDebugLogDir(cwd: string, config: PantheonConfig): string {
  const configured = config.debug?.logDir?.trim() || ".oh-my-opencode-pi-debug";
  return ensureDir(path.isAbsolute(configured) ? configured : path.join(cwd, configured));
}

function writeDebugText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text, "utf8");
}

function writeDebugJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createDebugTrace(cwd: string, config: PantheonConfig, kind: string, payload: Record<string, unknown>): DebugTraceContext | undefined {
  if (config.debug?.enabled === false) return undefined;
  const id = randomId(`trace_${safeDebugName(kind)}`);
  const dir = ensureDir(path.join(resolveDebugLogDir(cwd, config), id));
  const trace: DebugTraceContext = {
    id,
    kind,
    dir,
    eventsPath: path.join(dir, "events.ndjson"),
    summaryPath: path.join(dir, "summary.json"),
  };
  writeDebugJson(trace.summaryPath, { id, kind, startedAt: Date.now(), ...payload });
  writeDebugText(trace.eventsPath, `${JSON.stringify({ ts: Date.now(), type: "trace_start", kind, payload })}\n`);
  return trace;
}

function appendDebugEvent(trace: DebugTraceContext | undefined, type: string, payload: Record<string, unknown>): void {
  if (!trace) return;
  writeDebugText(trace.eventsPath, `${JSON.stringify({ ts: Date.now(), type, ...payload })}\n`);
}

function updateDebugTraceSummary(trace: DebugTraceContext | undefined, payload: Record<string, unknown>): void {
  if (!trace) return;
  const current = fs.existsSync(trace.summaryPath)
    ? JSON.parse(fs.readFileSync(trace.summaryPath, "utf8")) as Record<string, unknown>
    : {};
  writeDebugJson(trace.summaryPath, { ...current, ...payload });
}

function createSubagentDebugContext(
  trace: DebugTraceContext | undefined,
  label: string,
  payload: Record<string, unknown>,
): SubagentDebugContext | undefined {
  if (!trace) return undefined;
  const dir = ensureDir(path.join(trace.dir, safeDebugName(label)));
  const debug: SubagentDebugContext = {
    traceId: trace.id,
    label,
    dir,
    stdoutPath: path.join(dir, "stdout.ndjson"),
    stderrPath: path.join(dir, "stderr.log"),
    summaryPath: path.join(dir, "summary.json"),
  };
  writeDebugJson(debug.summaryPath, { label, traceId: trace.id, startedAt: Date.now(), ...payload });
  appendDebugEvent(trace, "subagent_start", { label, dir, ...payload });
  return debug;
}

function listDebugTraces(debugDir: string): Array<{ id: string; summaryPath: string; summary?: Record<string, unknown> }> {
  if (!fs.existsSync(debugDir)) return [];
  return fs.readdirSync(debugDir)
    .map((entry) => {
      const summaryPath = path.join(debugDir, entry, "summary.json");
      if (!fs.existsSync(summaryPath)) return undefined;
      try {
        return { id: entry, summaryPath, summary: JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<string, unknown> };
      } catch {
        return { id: entry, summaryPath, summary: undefined };
      }
    })
    .filter((item): item is { id: string; summaryPath: string; summary?: Record<string, unknown> } => Boolean(item))
    .sort((a, b) => Number(b.summary?.finishedAt ?? b.summary?.startedAt ?? 0) - Number(a.summary?.finishedAt ?? a.summary?.startedAt ?? 0));
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<any>) => void;

async function runSingleAgent(
  defaultCwd: string,
  agent: AgentConfig,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  debug?: SubagentDebugContext,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.options?.length) args.push(...agent.options);
  if (agent.noTools) args.push("--no-tools");
  else if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: summarizeResult(currentResult) || "(running...)" }],
      details: { results: [currentResult] },
    });
  };

  if (agent.systemPrompt.trim()) {
    args.push("--append-system-prompt", agent.systemPrompt);
  }

  args.push(`Task: ${task}`);
  const invocation = getPiInvocation(args);
  const startedAt = Date.now();
  if (debug) {
    writeDebugJson(debug.summaryPath, {
      label: debug.label,
      startedAt,
      cwd: cwd ?? defaultCwd,
      agent: agent.name,
      task,
      step,
      model: agent.model,
      command: invocation.command,
      args: invocation.args,
    });
  }

  let abortReason: string | undefined;
  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        [SUBAGENT_ENV]: "1",
        [AGENT_ENV]: agent.name,
      },
    });
    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      if (debug) writeDebugText(debug.stdoutPath, `${line}\n`);
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        currentResult.messages.push(msg);

        if (msg.role === "assistant") {
          currentResult.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            currentResult.usage.input += usage.input || 0;
            currentResult.usage.output += usage.output || 0;
            currentResult.usage.cacheRead += usage.cacheRead || 0;
            currentResult.usage.cacheWrite += usage.cacheWrite || 0;
            currentResult.usage.cost += usage.cost?.total || 0;
            currentResult.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!currentResult.model && msg.model) currentResult.model = msg.model;
          if (msg.stopReason) currentResult.stopReason = msg.stopReason;
          if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
        }
        emitUpdate();
      }

      if (event.type === "tool_result_end" && event.message) {
        currentResult.messages.push(event.message as Message);
        emitUpdate();
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      currentResult.stderr += text;
      if (debug) writeDebugText(debug.stderrPath, text);
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", (error) => {
      currentResult.errorMessage = error instanceof Error ? error.message : String(error);
      if (debug) writeDebugText(debug.stderrPath, `${currentResult.errorMessage}\n`);
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        abortReason = String(signal.reason ?? "aborted");
        currentResult.abortReason = abortReason;
        currentResult.stopReason = "aborted";
        currentResult.errorMessage = `Subagent aborted (${abortReason})`;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });

  currentResult.exitCode = exitCode;
  if (abortReason && !currentResult.stderr.includes(`Subagent aborted (${abortReason})`)) {
    currentResult.stderr = `${currentResult.stderr}${currentResult.stderr ? "\n" : ""}Subagent aborted (${abortReason})`;
  }
  if (debug) {
    writeDebugJson(debug.summaryPath, {
      label: debug.label,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      cwd: cwd ?? defaultCwd,
      agent: agent.name,
      task,
      step,
      command: invocation.command,
      args: invocation.args,
      result: currentResult,
    });
  }
  return currentResult;
}

async function runSingleAgentWithFallback(
  ctxCwd: string,
  agentName: string,
  agent: AgentConfig,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  explicitModels?: string[],
  debugTrace?: DebugTraceContext,
  debugLabel?: string,
  attemptTimeoutMs?: number,
): Promise<SingleResult> {
  const config = loadPantheonConfig(ctxCwd).config;
  const timeoutMs = typeof attemptTimeoutMs === "number"
    ? Math.max(0, Math.floor(attemptTimeoutMs))
    : resolveDelegateAttemptTimeoutMs(config, agentName);
  const retryDelayMs = Math.max(0, Math.floor(config.fallback?.retryDelayMs ?? 500));
  const retryOnEmpty = config.fallback?.retryOnEmpty !== false;
  const models = explicitModels && explicitModels.length > 0
    ? explicitModels
    : getFallbackModels(config, agentName, agent.model);
  const attempts = models.length > 0 ? models : [agent.model].filter((v): v is string => Boolean(v));
  const modelAttempts = attempts.length > 0 ? attempts : [undefined];

  let lastResult: SingleResult | undefined;
  for (let attemptIndex = 0; attemptIndex < modelAttempts.length; attemptIndex++) {
    const model = modelAttempts[attemptIndex];
    const attemptAgent: AgentConfig = { ...agent, model };
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason ? `parent:${String(signal.reason)}` : "parent-signal");
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason ? `parent:${String(signal.reason)}` : "parent-signal");
      else signal.addEventListener("abort", relayAbort, { once: true });
    }
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort("timeout"), timeoutMs) : undefined;

    const debug = createSubagentDebugContext(
      debugTrace,
      `${debugLabel ?? agentName}${step ? `-step-${step}` : ""}-attempt-${attemptIndex + 1}${model ? `-${model}` : ""}`,
      { agentName, model, step, cwd: cwd ?? ctxCwd, task, timeoutMs },
    );

    try {
      appendDebugEvent(debugTrace, "attempt_start", { agentName, model, step, attempt: attemptIndex + 1, label: debug?.label, timeoutMs });
      const result = await runSingleAgent(ctxCwd, attemptAgent, task, cwd, step, controller.signal, onUpdate, debug);
      lastResult = result;
      const emptyResponse = !hasMeaningfulResult(result);
      if (emptyResponse && retryOnEmpty && !result.errorMessage) {
        result.errorMessage = "Empty response from provider";
      }
      appendDebugEvent(debugTrace, "attempt_finish", {
        agentName,
        model,
        step,
        attempt: attemptIndex + 1,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
        abortReason: result.abortReason,
        errorMessage: result.errorMessage,
        emptyResponse,
      });
      if (isSuccessfulResult(result, { allowEmpty: !retryOnEmpty })) return result;
      if (result.abortReason && result.abortReason !== "timeout") return result;
      if (attemptIndex < modelAttempts.length - 1 && retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", relayAbort);
    }
  }

  return lastResult ?? {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 1,
    messages: [],
    stderr: "All model attempts failed",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
    errorMessage: "All model attempts failed",
  };
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Pantheon agent to invoke" }),
  task: Type.String({ description: "Task to delegate" }),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for this task" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Pantheon agent to invoke" }),
  task: Type.String({ description: "Task to delegate. Supports {previous} placeholder." }),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for this task" })),
});

const DelegateParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Pantheon agent for single mode" })),
  task: Type.Optional(Type.String({ description: "Task for single mode" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential tasks with {previous} placeholder support" })),
  includeProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Also load project-local .pi/agents overrides. Default false.",
      default: false,
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for single mode" })),
});

const CouncilParams = Type.Object({
  prompt: Type.String({ description: "Prompt to send to the council" }),
  preset: Type.Optional(Type.String({ description: "Optional council preset name" })),
  includeProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Also load project-local .pi/agents overrides. Default false.",
      default: false,
    }),
  ),
});

const BackgroundParams = Type.Object({
  agent: Type.String({ description: "Pantheon agent to run in background" }),
  task: Type.String({ description: "Task for the background agent" }),
  includeProjectAgents: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory" })),
});

const BackgroundStatusParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Specific background task id" })),
});

const BackgroundWaitParams = Type.Object({
  taskId: Type.String({ description: "Background task id to wait for" }),
  timeoutMs: Type.Optional(Type.Number({ description: "Maximum time to wait in milliseconds", default: 60000 })),
  pollIntervalMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds", default: 1500 })),
});

const BackgroundResultParams = Type.Object({
  taskId: Type.String({ description: "Background task id" }),
  includeLogTail: Type.Optional(Type.Boolean({ description: "Include recent log tail", default: false })),
  logLines: Type.Optional(Type.Number({ description: "Number of log lines to include", default: 60 })),
});

const BackgroundRetryParams = Type.Object({
  taskId: Type.String({ description: "Background task id to retry" }),
});

const BackgroundCancelParams = Type.Object({
  taskId: Type.String({ description: "Background task id to cancel" }),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch" }),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Web search query" }),
  scope: Type.Optional(Type.String({ description: "Optional search scope: web, github, or docs" })),
  site: Type.Optional(Type.String({ description: "Optional docs site/domain restriction, e.g. nextjs.org" })),
  repo: Type.Optional(Type.String({ description: "Optional GitHub repo owner/name for targeted repo research" })),
});

const AdapterSearchParams = Type.Object({
  adapter: Type.Optional(Type.String({ description: "Adapter id to use, e.g. docs-context7, grep-app, web-search, github-releases, or auto." })),
  query: Type.String({ description: "Adapter search query or lookup prompt." }),
  package: Type.Optional(Type.String({ description: "Optional npm package name for docs-oriented adapters." })),
  version: Type.Optional(Type.String({ description: "Optional exact package version." })),
  repo: Type.Optional(Type.String({ description: "Optional GitHub repo owner/name." })),
  site: Type.Optional(Type.String({ description: "Optional docs site/domain hint." })),
  topic: Type.Optional(Type.String({ description: "Optional docs topic to resolve or search for." })),
  limit: Type.Optional(Type.Number({ description: "Maximum results to return.", default: 5 })),
});

const AdapterFetchParams = Type.Object({
  adapter: Type.String({ description: "Adapter id to fetch with." }),
  query: Type.Optional(Type.String({ description: "Optional adapter query or lookup hint." })),
  package: Type.Optional(Type.String({ description: "Optional npm package name for docs-oriented adapters." })),
  version: Type.Optional(Type.String({ description: "Optional exact package version." })),
  repo: Type.Optional(Type.String({ description: "Optional GitHub repo owner/name." })),
  site: Type.Optional(Type.String({ description: "Optional docs site/domain hint." })),
  topic: Type.Optional(Type.String({ description: "Optional docs topic." })),
  url: Type.Optional(Type.String({ description: "Optional explicit URL for docs/web fetches." })),
  path: Type.Optional(Type.String({ description: "Optional GitHub file path or other adapter-specific path." })),
  limit: Type.Optional(Type.Number({ description: "Optional release/result count.", default: 5 })),
  maxChars: Type.Optional(Type.Number({ description: "Maximum response characters to return.", default: 12000 })),
});

const BackgroundLogParams = Type.Object({
  taskId: Type.String({ description: "Background task id" }),
  lines: Type.Optional(Type.Number({ description: "Number of log lines to return", default: 80 })),
});

const AutoContinueParams = Type.Object({
  enabled: Type.Boolean({ description: "Enable or disable auto-continue" }),
});

const InterviewParams = Type.Object({
  objective: Type.String({ description: "What should be built or changed" }),
  users: Type.String({ description: "Target users or stakeholders" }),
  constraints: Type.String({ description: "Constraints, risks, or non-goals" }),
  success: Type.String({ description: "How success should be measured" }),
  notes: Type.Optional(Type.String({ description: "Additional notes" })),
  title: Type.Optional(Type.String({ description: "Specification title" })),
});

const GithubFileParams = Type.Object({
  repo: Type.String({ description: "GitHub repo in owner/name form" }),
  path: Type.String({ description: "Path inside the repo" }),
  ref: Type.Optional(Type.String({ description: "Git ref, branch, or tag. Default: HEAD" })),
});

const NpmInfoParams = Type.Object({
  package: Type.String({ description: "npm package name" }),
  version: Type.Optional(Type.String({ description: "Optional exact version to inspect" })),
});

const PackageDocsParams = Type.Object({
  package: Type.String({ description: "npm package name" }),
  version: Type.Optional(Type.String({ description: "Optional exact version to inspect" })),
  maxChars: Type.Optional(Type.Number({ description: "Maximum README characters to return", default: 12000 })),
});

const ResolveDocsParams = Type.Object({
  package: Type.Optional(Type.String({ description: "Optional npm package name." })),
  version: Type.Optional(Type.String({ description: "Optional exact package version." })),
  repo: Type.Optional(Type.String({ description: "Optional GitHub repo in owner/name form." })),
  site: Type.Optional(Type.String({ description: "Optional docs domain or site hint, e.g. nextjs.org." })),
  topic: Type.Optional(Type.String({ description: "Optional docs topic to search for." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum docs search candidates to return.", default: 5 })),
});

const FetchDocsParams = Type.Object({
  package: Type.Optional(Type.String({ description: "Optional npm package name." })),
  version: Type.Optional(Type.String({ description: "Optional exact package version." })),
  repo: Type.Optional(Type.String({ description: "Optional GitHub repo in owner/name form." })),
  site: Type.Optional(Type.String({ description: "Optional docs domain or site hint, e.g. nextjs.org." })),
  topic: Type.Optional(Type.String({ description: "Optional docs topic to search for before fetching a page." })),
  url: Type.Optional(Type.String({ description: "Optional explicit URL to fetch instead of resolving docs sources." })),
  maxChars: Type.Optional(Type.Number({ description: "Maximum response characters to return.", default: 12000 })),
});

const GithubReleasesParams = Type.Object({
  repo: Type.String({ description: "GitHub repo in owner/name form" }),
  limit: Type.Optional(Type.Number({ description: "Maximum releases to return", default: 5 })),
});

const WorkflowStateParams = Type.Object({
  action: Type.String({ description: "Action: get, set, or clear" }),
  todos: Type.Optional(Type.Array(Type.String({ description: "Unchecked todo item" }))),
  summary: Type.Optional(Type.String({ description: "Optional last-agent summary to store" })),
});

const ResumeContextParams = Type.Object({
  maxTasks: Type.Optional(Type.Number({ description: "Maximum recent background tasks to include", default: 6 })),
  includeCompletedBackground: Type.Optional(Type.Boolean({ description: "Include completed background tasks", default: true })),
  includeFailedBackground: Type.Optional(Type.Boolean({ description: "Include failed/cancelled background tasks", default: true })),
});

const BackgroundOverviewParams = Type.Object({
  maxRecent: Type.Optional(Type.Number({ description: "Maximum recent tasks to include", default: 8 })),
});

const BackgroundAttachParams = Type.Object({
  taskId: Type.String({ description: "Background task id" }),
});

function buildCouncilPrompt(userPrompt: string, rolePrompt?: string): string {
  return rolePrompt?.trim()
    ? `${rolePrompt.trim()}\n\n---\n\n${userPrompt}`
    : userPrompt;
}

async function fetchRaw(
  url: string,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", relay, { once: true });
  }
  try {
    const response = await fetch(url, {
      headers: { "user-agent": userAgent, ...extraHeaders },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status} ${response.statusText}) for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relay);
  }
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const raw = await fetchRaw(url, timeoutMs, userAgent, signal, { accept: "application/json", ...extraHeaders });
  return JSON.parse(raw) as T;
}

function htmlToText(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function maybeNormalizeGithubBlobUrl(url: string): string {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (!match) return url;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

async function fetchText(url: string, timeoutMs: number, userAgent: string, signal?: AbortSignal): Promise<string> {
  const normalizedUrl = maybeNormalizeGithubBlobUrl(url);
  const raw = await fetchRaw(normalizedUrl, timeoutMs, userAgent, signal);
  const isHtml = /<html|<body|<title/i.test(raw);
  if (!isHtml) {
    return `URL: ${normalizedUrl}\n\n${raw}`;
  }
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? htmlToText(titleMatch[1]) : undefined;
  const body = htmlToText(raw);
  return title ? `Title: ${title}\nURL: ${normalizedUrl}\n\n${body}` : `URL: ${normalizedUrl}\n\n${body}`;
}

function parseDuckDuckGoHref(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

function buildSearchQuery(query: string, scope?: string, site?: string, repo?: string, defaultDocsSite?: string): string {
  let scoped = query;
  if (scope === "github") scoped = `${scoped} site:github.com`;
  if (scope === "docs") scoped = `${scoped} (documentation OR docs OR api)`;
  if (repo?.trim()) scoped = `${scoped} ${repo.trim()} site:github.com/${repo.trim()}`;
  const docsSite = site?.trim() || (scope === "docs" ? defaultDocsSite?.trim() : undefined);
  if (docsSite) scoped = `${scoped} site:${docsSite}`;
  return scoped;
}

function extractSearchResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet?: string }> {
  const matches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, maxResults);
  return matches.map((match) => {
    const start = match.index ?? 0;
    const window = html.slice(start, start + 1400);
    const snippetMatch = window.match(/class="(?:result__snippet|result__extras__url)"[^>]*>([\s\S]*?)<\//i);
    return {
      title: htmlToText(match[2]),
      url: parseDuckDuckGoHref(match[1]),
      snippet: snippetMatch ? htmlToText(snippetMatch[1]) : undefined,
    };
  });
}

async function webSearchResults(
  query: string,
  timeoutMs: number,
  userAgent: string,
  maxResults: number,
  signal?: AbortSignal,
  scope?: string,
  site?: string,
  repo?: string,
  defaultDocsSite?: string,
): Promise<Array<{ title: string; url: string; snippet?: string }>> {
  const scopedQuery = buildSearchQuery(query, scope, site, repo, defaultDocsSite);
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(scopedQuery)}`;
  const html = await fetchRaw(url, timeoutMs, userAgent, signal);
  return extractSearchResults(html, maxResults);
}

async function webSearch(
  query: string,
  timeoutMs: number,
  userAgent: string,
  maxResults: number,
  signal?: AbortSignal,
  scope?: string,
  site?: string,
  repo?: string,
  defaultDocsSite?: string,
): Promise<string> {
  const results = await webSearchResults(query, timeoutMs, userAgent, maxResults, signal, scope, site, repo, defaultDocsSite);
  if (results.length === 0) {
    const scopedQuery = buildSearchQuery(query, scope, site, repo, defaultDocsSite);
    return `No search results found for: ${scopedQuery}`;
  }
  return results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`).join("\n\n");
}

function githubRawUrl(repo: string, filePath: string, ref?: string): string {
  return `https://raw.githubusercontent.com/${repo}/${ref?.trim() || "HEAD"}/${filePath.replace(/^\/+/, "")}`;
}

async function fetchGithubFile(
  repo: string,
  filePath: string,
  ref: string | undefined,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  githubToken?: string,
): Promise<string> {
  const resolvedRef = ref?.trim() || "HEAD";
  if (githubToken?.trim()) {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath.replace(/^\/+/, "")}?ref=${encodeURIComponent(resolvedRef)}`;
    const payload = await fetchJson<any>(apiUrl, timeoutMs, userAgent, signal, {
      authorization: `Bearer ${githubToken.trim()}`,
      accept: "application/vnd.github+json",
    });
    const content = typeof payload.content === "string" ? Buffer.from(payload.content.replace(/\n/g, ""), payload.encoding || "base64").toString("utf8") : JSON.stringify(payload, null, 2);
    return `Repo: ${repo}\nRef: ${resolvedRef}\nPath: ${filePath}\nURL: ${payload.html_url || apiUrl}\n\n${content}`;
  }
  const url = githubRawUrl(repo, filePath, resolvedRef);
  const content = await fetchRaw(url, timeoutMs, userAgent, signal);
  return `Repo: ${repo}\nRef: ${resolvedRef}\nPath: ${filePath}\nURL: ${url}\n\n${content}`;
}

async function fetchNpmInfo(pkg: string, version: string | undefined, timeoutMs: number, userAgent: string, signal?: AbortSignal): Promise<string> {
  const metadata = await fetchJson<any>(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, timeoutMs, userAgent, signal);
  const versionKey = version?.trim() || metadata["dist-tags"]?.latest;
  const selected = versionKey ? metadata.versions?.[versionKey] : undefined;
  const latest = metadata["dist-tags"]?.latest;
  const repo = selected?.repository?.url || metadata.repository?.url;
  const homepage = selected?.homepage || metadata.homepage;
  const lines = [
    `Package: ${metadata.name || pkg}`,
    `Requested version: ${version?.trim() || "latest"}`,
    `Resolved version: ${selected?.version || versionKey || "unknown"}`,
    `Latest dist-tag: ${latest || "unknown"}`,
    selected?.description || metadata.description ? `Description: ${selected?.description || metadata.description}` : undefined,
    homepage ? `Homepage: ${homepage}` : undefined,
    repo ? `Repository: ${repo}` : undefined,
    Array.isArray(selected?.keywords) && selected.keywords.length > 0 ? `Keywords: ${selected.keywords.join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function parseGithubRepo(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  const cleaned = repoUrl.replace(/^git\+/, "").replace(/\.git$/, "");
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (httpsMatch) return httpsMatch[1];
  return undefined;
}

function hostnameOfUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

async function resolveDocsSources(
  pkg: string | undefined,
  version: string | undefined,
  repo: string | undefined,
  site: string | undefined,
  timeoutMs: number,
  userAgent: string,
  signal: AbortSignal | undefined,
): Promise<{
  packageName?: string;
  repo?: string;
  homepage?: string;
  docsSite?: string;
  candidates: Array<{ label: string; url: string }>;
}> {
  let packageName = pkg?.trim() || undefined;
  let resolvedRepo = repo?.trim() || undefined;
  let homepage: string | undefined;
  let gitRef: string | undefined;

  if (packageName) {
    const metadata = await fetchJson<any>(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, timeoutMs, userAgent, signal);
    const versionKey = version?.trim() || metadata["dist-tags"]?.latest;
    const selected = versionKey ? metadata.versions?.[versionKey] : undefined;
    homepage = selected?.homepage || metadata.homepage;
    gitRef = selected?.gitHead;
    if (!resolvedRepo) {
      resolvedRepo = parseGithubRepo(selected?.repository?.url || metadata.repository?.url);
    }
  }

  const docsSite = site?.trim() || hostnameOfUrl(homepage);
  const rawCandidates = [
    homepage ? { label: "Homepage", url: homepage } : undefined,
    docsSite ? { label: "Docs site", url: `https://${docsSite}` } : undefined,
    packageName ? { label: "npm package", url: `https://www.npmjs.com/package/${packageName}` } : undefined,
    resolvedRepo ? { label: "GitHub repository", url: `https://github.com/${resolvedRepo}` } : undefined,
    resolvedRepo ? { label: "GitHub README", url: githubRawUrl(resolvedRepo, "README.md", gitRef) } : undefined,
  ].filter((candidate): candidate is { label: string; url: string } => Boolean(candidate));

  const seen = new Set<string>();
  const candidates = rawCandidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });

  return { packageName, repo: resolvedRepo, homepage, docsSite, candidates };
}

async function fetchDocsEntry(
  params: {
    package?: string;
    version?: string;
    repo?: string;
    site?: string;
    topic?: string;
    url?: string;
  },
  timeoutMs: number,
  userAgent: string,
  signal: AbortSignal | undefined,
  maxChars: number,
): Promise<string> {
  if (params.url?.trim()) {
    return previewText(await fetchText(params.url.trim(), timeoutMs, userAgent, signal), maxChars);
  }

  const resolved = await resolveDocsSources(params.package, params.version, params.repo, params.site, timeoutMs, userAgent, signal);
  if (params.topic?.trim() && (resolved.docsSite || resolved.repo)) {
    const results = await webSearchResults(
      params.topic.trim(),
      timeoutMs,
      userAgent,
      5,
      signal,
      resolved.docsSite ? "docs" : "github",
      resolved.docsSite,
      resolved.repo,
      resolved.docsSite,
    );
    if (results.length > 0) {
      const best = results[0];
      const fetched = await fetchText(best.url, timeoutMs, userAgent, signal);
      return previewText(`Resolved docs result: ${best.title}\nURL: ${best.url}${best.snippet ? `\nSnippet: ${best.snippet}` : ""}\n\n${fetched}`, maxChars);
    }
  }

  if (params.package?.trim()) {
    return previewText(await fetchPackageDocs(params.package.trim(), params.version, timeoutMs, userAgent, signal, maxChars, undefined), maxChars);
  }

  const firstCandidate = resolved.candidates[0];
  if (!firstCandidate) {
    throw new Error("Unable to resolve documentation sources. Provide `url`, `package`, `repo`, or `site`.");
  }
  return previewText(await fetchText(firstCandidate.url, timeoutMs, userAgent, signal), maxChars);
}

async function fetchPackageDocs(
  pkg: string,
  version: string | undefined,
  timeoutMs: number,
  userAgent: string,
  signal: AbortSignal | undefined,
  maxChars: number,
  githubToken?: string,
): Promise<string> {
  const metadata = await fetchJson<any>(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, timeoutMs, userAgent, signal);
  const versionKey = version?.trim() || metadata["dist-tags"]?.latest;
  const selected = versionKey ? metadata.versions?.[versionKey] : undefined;
  const repoUrl = selected?.repository?.url || metadata.repository?.url;
  const repo = parseGithubRepo(repoUrl);
  let readme = typeof metadata.readme === "string" && metadata.readme.trim().length > 0 ? metadata.readme.trim() : undefined;

  if (!readme && repo) {
    for (const candidate of ["README.md", "readme.md", "README", "docs/README.md"]) {
      try {
        readme = await fetchGithubFile(repo, candidate, selected?.gitHead, timeoutMs, userAgent, signal, githubToken);
        if (readme) break;
      } catch {
        // try next candidate
      }
    }
  }

  const header = await fetchNpmInfo(pkg, version, timeoutMs, userAgent, signal);
  const excerpt = readme ? previewText(readme, Math.max(1000, Math.floor(maxChars || 12000))) : "(No README found via npm metadata or GitHub fallback)";
  return `${header}\n\nREADME excerpt:\n\n${excerpt}`;
}

async function fetchGithubReleases(
  repo: string,
  limit: number,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  githubToken?: string,
): Promise<string> {
  const releases = await fetchJson<any[]>(`https://api.github.com/repos/${repo}/releases?per_page=${Math.max(1, Math.min(20, Math.floor(limit || 5)))}`,
    timeoutMs,
    userAgent,
    signal,
    githubToken?.trim()
      ? { authorization: `Bearer ${githubToken.trim()}`, accept: "application/vnd.github+json" }
      : { accept: "application/vnd.github+json" },
  );
  if (!Array.isArray(releases) || releases.length === 0) {
    return `Repo: ${repo}\n\nNo GitHub releases found.`;
  }
  return `Repo: ${repo}\n\n${releases.map((release, index) => {
    const body = typeof release.body === "string" && release.body.trim() ? previewText(release.body.trim(), 1800) : "(no release notes)";
    return `${index + 1}. ${release.name || release.tag_name || "unnamed release"}\n   Tag: ${release.tag_name || "unknown"}\n   Published: ${release.published_at || "unknown"}${release.prerelease ? "\n   Prerelease: yes" : ""}\n   URL: ${release.html_url || "unknown"}\n\n${body}`;
  }).join("\n\n---\n\n")}`;
}

interface AdapterInvocationParams {
  query?: string;
  package?: string;
  version?: string;
  repo?: string;
  site?: string;
  topic?: string;
  url?: string;
  path?: string;
  limit?: number;
  maxChars?: number;
}

interface AdapterSummary {
  text: string;
  details?: unknown;
}

interface PantheonAdapter {
  id: string;
  label: string;
  description: string;
  search(params: AdapterInvocationParams, config: PantheonConfig, signal?: AbortSignal): Promise<AdapterSummary>;
  fetch(params: AdapterInvocationParams, config: PantheonConfig, signal?: AbortSignal): Promise<AdapterSummary>;
}

async function searchGrepApp(
  query: string,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  limit = 5,
  repo?: string,
): Promise<AdapterSummary> {
  const url = new URL("https://grep.app/api/search");
  url.searchParams.set("q", query);
  url.searchParams.set("page", "1");
  if (repo?.trim()) url.searchParams.set("f.repo.pattern", repo.trim());
  const payload = await fetchJson<any>(url.toString(), timeoutMs, userAgent, signal, { accept: "application/json" });
  const hits = Array.isArray(payload?.hits?.hits) ? payload.hits.hits.slice(0, Math.max(1, Math.min(20, Math.floor(limit)))) : [];
  if (hits.length === 0) {
    return { text: `Adapter: grep-app\nQuery: ${query}\n\nNo public code results found.` };
  }
  const lines = hits.map((hit: any, index: number) => {
    const repoName = hit?.repo?.raw ?? "unknown-repo";
    const filePath = hit?.path?.raw ?? hit?.path ?? "unknown-path";
    const snippetSource = Array.isArray(hit?.content?.snippet) ? hit.content.snippet.join(" … ") : hit?.content?.snippet;
    const snippet = typeof snippetSource === "string" ? htmlToText(snippetSource).replace(/\s+/g, " ").trim() : "";
    return `${index + 1}. ${repoName}/${filePath}\n   https://grep.app/search?q=${encodeURIComponent(query)}${repo?.trim() ? `&f.repo.pattern=${encodeURIComponent(repo.trim())}` : ""}${snippet ? `\n   ${snippet}` : ""}`;
  });
  return { text: `Adapter: grep-app\nQuery: ${query}\n\n${lines.join("\n\n")}`, details: { hits } };
}

function getCurrentPantheonAgent(): string | undefined {
  const value = process.env[AGENT_ENV]?.trim();
  return value ? value : undefined;
}

function getEffectiveAdapters(config: PantheonConfig): PantheonAdapter[] {
  const timeoutMs = config.research?.timeoutMs ?? 15000;
  const userAgent = config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0";
  const defaultDocsSite = config.research?.defaultDocsSite;
  const githubToken = config.research?.githubToken;

  return [
    {
      id: "docs-context7",
      label: "Docs Context",
      description: "Package/repo/site-aware docs resolution and fetch, similar to a Context7-style docs source.",
      async search(params, _config, signal) {
        const resolved = await resolveDocsSources(params.package, params.version, params.repo, params.site, timeoutMs, userAgent, signal);
        const candidates = params.topic?.trim()
          ? await webSearchResults(params.topic.trim(), timeoutMs, userAgent, Math.max(1, Math.min(10, Math.floor(params.limit ?? 5))), signal, resolved.docsSite ? "docs" : "github", resolved.docsSite, resolved.repo, defaultDocsSite)
          : [];
        const lines = [
          `Adapter: docs-context7`,
          resolved.packageName ? `Package: ${resolved.packageName}` : undefined,
          resolved.repo ? `Repo: ${resolved.repo}` : undefined,
          resolved.docsSite ? `Docs site: ${resolved.docsSite}` : undefined,
          "",
          candidates.length > 0
            ? candidates.map((candidate, index) => `${index + 1}. ${candidate.title}\n   ${candidate.url}${candidate.snippet ? `\n   ${candidate.snippet}` : ""}`).join("\n\n")
            : resolved.candidates.length > 0
              ? resolved.candidates.map((candidate, index) => `${index + 1}. ${candidate.label}\n   ${candidate.url}`).join("\n\n")
              : "No docs candidates found.",
        ].filter((line): line is string => Boolean(line));
        return { text: lines.join("\n") };
      },
      async fetch(params, _config, signal) {
        return {
          text: await fetchDocsEntry({
            package: params.package,
            version: params.version,
            repo: params.repo,
            site: params.site,
            topic: params.topic ?? params.query,
            url: params.url,
          }, timeoutMs, userAgent, signal, params.maxChars ?? 12000),
        };
      },
    },
    {
      id: "grep-app",
      label: "grep.app",
      description: "Public code search over indexed repositories, similar to grep.app.",
      async search(params, _config, signal) {
        return searchGrepApp(params.query?.trim() || params.topic?.trim() || "", timeoutMs, userAgent, signal, params.limit, params.repo);
      },
      async fetch(params, _config, signal) {
        return searchGrepApp(params.query?.trim() || params.topic?.trim() || "", timeoutMs, userAgent, signal, params.limit, params.repo);
      },
    },
    {
      id: "github-releases",
      label: "GitHub Releases",
      description: "Structured GitHub release-note and changelog retrieval.",
      async search(params, _config, signal) {
        if (!params.repo?.trim()) throw new Error("github-releases requires `repo`.");
        return {
          text: await fetchGithubReleases(params.repo.trim(), params.limit ?? 5, timeoutMs, userAgent, signal, githubToken),
        };
      },
      async fetch(params, _config, signal) {
        if (!params.repo?.trim()) throw new Error("github-releases requires `repo`.");
        return {
          text: await fetchGithubReleases(params.repo.trim(), params.limit ?? 5, timeoutMs, userAgent, signal, githubToken),
        };
      },
    },
    {
      id: "web-search",
      label: "Web Search",
      description: "Generic web/docs/github search fallback.",
      async search(params, _config, signal) {
        return {
          text: await webSearch(
            params.query?.trim() || params.topic?.trim() || "",
            timeoutMs,
            userAgent,
            Math.max(1, Math.min(10, Math.floor(params.limit ?? config.research?.maxResults ?? 5))),
            signal,
            params.site ? "docs" : undefined,
            params.site,
            params.repo,
            defaultDocsSite,
          ),
        };
      },
      async fetch(params, _config, signal) {
        if (params.url?.trim()) {
          return { text: previewText(await fetchText(params.url.trim(), timeoutMs, userAgent, signal), params.maxChars ?? 12000) };
        }
        const results = await webSearchResults(
          params.query?.trim() || params.topic?.trim() || "",
          timeoutMs,
          userAgent,
          1,
          signal,
          params.site ? "docs" : undefined,
          params.site,
          params.repo,
          defaultDocsSite,
        );
        if (results.length === 0) throw new Error("No web-search results found.");
        return { text: previewText(await fetchText(results[0].url, timeoutMs, userAgent, signal), params.maxChars ?? 12000) };
      },
    },
  ];
}

function selectAdapterIds(config: PantheonConfig, requested: string | undefined, params: AdapterInvocationParams): string[] {
  const requestedId = requested?.trim();
  if (requestedId && requestedId !== "auto") return [requestedId];
  if (params.url || params.package || params.site || params.topic) return ["docs-context7"];
  if (params.repo && /(release|changelog|version)/i.test(params.query ?? "")) return ["github-releases"];
  if (params.repo || /(snippet|usage|implementation|example|symbol|pattern|code)/i.test(params.query ?? "")) return ["grep-app", "web-search"];
  return ["web-search", "docs-context7"];
}

function getAllowedAdapters(config: PantheonConfig): { agentName?: string; adapters: PantheonAdapter[] } {
  const all = getEffectiveAdapters(config);
  const agentName = getCurrentPantheonAgent();
  const policy = resolveAgentAdapterPolicy(config, agentName ?? "interactive");
  if (policy.disableAll) return { agentName, adapters: [] };
  const adapters = all.filter((adapter) => {
    if (policy.disabled.includes(adapter.id)) return false;
    if (policy.deny.includes(adapter.id)) return false;
    if (policy.allow.length > 0 && !policy.allow.includes(adapter.id)) return false;
    return true;
  });
  return { agentName, adapters };
}

function requireAdapter(config: PantheonConfig, adapterId: string): PantheonAdapter {
  const { agentName, adapters } = getAllowedAdapters(config);
  const adapter = adapters.find((item) => item.id === adapterId);
  if (!adapter) {
    const current = getEffectiveAdapters(config).map((item) => item.id).join(", ");
    throw new Error(`Adapter '${adapterId}' is not available for ${agentName ?? "this session"}. Available adapters: ${adapters.map((item) => item.id).join(", ") || "(none)"}. Registered adapters: ${current || "(none)"}.`);
  }
  return adapter;
}

function isTerminalTaskStatus(status: BackgroundTaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new Error("Aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function buildMasterTask(prompt: string, councillors: Array<SingleResult & { memberName: string }>, masterGuidance?: string): string {
  const sections = councillors
    .map((result) => {
      const answer = summarizeResult(result).trim();
      return `## ${result.memberName}\nModel: ${result.model ?? "default"}\n\n${answer || "(no output)"}`;
    })
    .join("\n\n");

  let task = `Original question:\n${prompt}\n\nCouncillor responses:\n\n${sections}\n\nSynthesize the strongest answer. Return a single final answer. If the councillors disagree, explain the trade-off and choose.`;
  if (masterGuidance?.trim()) {
    task += `\n\n---\n**Master Guidance**\n${masterGuidance.trim()}`;
  }
  return task;
}

async function runCouncil(
  cwd: string,
  includeProjectAgents: boolean,
  prompt: string,
  presetName: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  debugTrace?: DebugTraceContext,
): Promise<CouncilRunResult> {
  const discovery = discoverPantheonAgents(cwd, includeProjectAgents);
  const configResult = loadPantheonConfig(cwd);
  const config = configResult.config;
  const resolvedDefault = resolveCouncilPreset(config);
  const preset = presetName && config.council?.presets?.[presetName]
    ? config.council.presets[presetName]
    : resolvedDefault.preset;
  const resolvedPresetName = presetName && config.council?.presets?.[presetName]
    ? presetName
    : resolvedDefault.name;

  const councillorAgent = discovery.agents.find((agent) => agent.name === "councillor");
  const masterAgentBase = discovery.agents.find((agent) => agent.name === "council-master");
  if (!councillorAgent || !masterAgentBase) {
    throw new Error("Bundled council agents are missing");
  }

  const members = preset.councillors?.length ? preset.councillors : [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
  const runningResults: Array<(SingleResult & { memberName: string }) | undefined> = new Array(members.length).fill(undefined);
  const councillorsTimeoutMs = resolveCouncilAttemptTimeoutMs(config, "councillors");
  const masterTimeoutMs = resolveCouncilAttemptTimeoutMs(config, "master");
  const allowEmptyCouncilResponses = config.fallback?.retryOnEmpty === false;

  const councillors = await mapWithConcurrencyLimit(members, 3, async (member: CouncilMemberConfig, index) => {
    const agent: AgentConfig = {
      ...councillorAgent,
      model: member.model ?? councillorAgent.model,
      options: member.options ?? councillorAgent.options,
    };

    const config = loadPantheonConfig(cwd).config;
    const result = await runSingleAgentWithFallback(
      cwd,
      "councillor",
      agent,
      buildCouncilPrompt(prompt, member.prompt),
      undefined,
      index + 1,
      signal,
      (partial) => {
        const current = partial.details?.results?.[0] as SingleResult | undefined;
        if (current) {
          runningResults[index] = { ...current, memberName: member.name };
          const completed = runningResults.filter(Boolean).length;
          onUpdate?.({
            content: [{ type: "text", text: `Council (${resolvedPresetName}): ${completed}/${members.length} councillors responded...` }],
            details: { preset: resolvedPresetName, councillors: runningResults.filter(Boolean) },
          });
        }
      },
      member.model ? [member.model, ...(config.fallback?.agentChains?.councillor ?? [])] : undefined,
      debugTrace,
      `councillor-${member.name}`,
      councillorsTimeoutMs,
    );

    return { ...result, memberName: member.name };
  });

  const failed = councillors.filter((result) => !isSuccessfulResult(result, { allowEmpty: allowEmptyCouncilResponses }));
  if (failed.length === councillors.length) {
    throw new Error(`All councillors failed: ${failed.map((item) => `${item.memberName}: ${summarizeResult(item)}`).join(" | ")}`);
  }

  const masterAgent: AgentConfig = {
    ...masterAgentBase,
    model: preset.master?.model ?? masterAgentBase.model,
    options: preset.master?.options ?? masterAgentBase.options,
  };
  const masterConfig = loadPantheonConfig(cwd).config;
  const masterModels = [masterAgent.model, ...(masterConfig.fallback?.councilMaster ?? [])].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
  const master = await runSingleAgentWithFallback(
    cwd,
    "council-master",
    masterAgent,
    buildMasterTask(prompt, councillors, preset.master?.prompt),
    undefined,
    undefined,
    signal,
    onUpdate,
    masterModels,
    debugTrace,
    "council-master",
    masterTimeoutMs,
  );

  return { preset: resolvedPresetName, master, councillors };
}

function getTaskStateChip(status: BackgroundTaskRecord["status"], theme: RenderTheme): string {
  if (status === "completed") return theme.fg("success", "✓ completed");
  if (status === "running") return theme.fg("warning", "… running");
  if (status === "queued") return theme.fg("muted", "○ queued");
  if (status === "cancelled") return theme.fg("muted", "— cancelled");
  return theme.fg("error", "✗ failed");
}

function formatBackgroundTaskLine(task: BackgroundTaskRecord, theme: RenderTheme, maxPreview = 100): string {
  return `${getTaskStateChip(task.status, theme)} ${theme.fg("accent", `${task.agent}`)} ${theme.fg("dim", task.id)} ${theme.fg("muted", "—")} ${previewText(task.summary ?? task.task, maxPreview)}`;
}

function renderBackgroundToolCall(
  toolName: string,
  args: { agent?: string; task?: string; taskId?: string },
  theme: RenderTheme,
) {
  const headline = args.agent
    ? `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", args.agent)}`
    : `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", args.taskId ?? "request")}`;
  const detail = args.task ? `\n  ${theme.fg("muted", previewText(args.task, 100))}` : "";
  return new Text(`${headline}${detail}`, 0, 0);
}

function renderBackgroundToolResult(
  toolName: string,
  result: { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord | BackgroundTaskRecord[] },
  expanded: boolean,
  theme: RenderTheme,
) {
  const details = result.details;
  if (!details) {
    const text = result.content[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
    return new Text(text, 0, 0);
  }
  const tasks = Array.isArray(details) ? details : [details];
  const lines = [
    `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`)}`,
  ];
  const visibleTasks = expanded ? tasks : tasks.slice(0, 6);
  for (const task of visibleTasks) lines.push(formatBackgroundTaskLine(task, theme, expanded ? 140 : 95));
  if (!expanded && tasks.length > visibleTasks.length) {
    lines.push(theme.fg("muted", `… +${tasks.length - visibleTasks.length} more (expand to view all)`));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function renderWorkflowToolResult(
  toolName: string,
  title: string,
  body: string,
  theme: RenderTheme,
): Text {
  return new Text(`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", title)}\n${body}`, 0, 0);
}

function rememberBackgroundTaskId(ctxCwd: string, config: PantheonConfig, taskId: string): void {
  if (config.workflow?.persistTodos === false) return;
  updateWorkflowState(ctxCwd, config, (state) => ({
    ...state,
    recentBackgroundTaskIds: [...(state.recentBackgroundTaskIds ?? []), taskId],
  }));
}

async function showPantheonSelect(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  hint = "↑↓ navigate • enter select • esc cancel",
): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const selectList = new SelectList(items, Math.min(Math.max(items.length, 3), 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(String(item.value));
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", hint), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      width: "72%",
      minWidth: 52,
      maxHeight: "80%",
      margin: 1,
    },
  });
}

export default function (pi: ExtensionAPI) {
  const orchestratorPrompt = loadOrchestratorPrompt();
  const notifiedTasks = new Set<string>();
  let poller: ReturnType<typeof setInterval> | undefined;
  let autoContinueEnabled = false;
  let autoContinueCount = 0;
  let autoContinueTimer: ReturnType<typeof setTimeout> | undefined;
  let latestConfig: PantheonConfig | undefined;
  let latestWarningCount = 0;
  let turnFileMutationCount = 0;
  let lastGuidanceAt = 0;

  const updatePantheonDashboard = (ctx: ExtensionContext, config = latestConfig ?? loadPantheonConfig(ctx.cwd).config) => {
    latestConfig = config;
    if (process.env[SUBAGENT_ENV] === "1" || config.ui?.dashboardWidget === false) {
      ctx.ui.setWidget("oh-my-opencode-pi-dashboard", undefined);
      return;
    }
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    const tasks = config.background?.enabled === false ? [] : maybeStartQueuedTasks(ctx.cwd, taskDir);
    const state = config.workflow?.persistTodos === false ? { updatedAt: 0, uncheckedTodos: [] } : readWorkflowState(ctx.cwd, config);
    const lines = buildPantheonDashboardLines(ctx, config, state, tasks, autoContinueEnabled, latestWarningCount);
    ctx.ui.setWidget("oh-my-opencode-pi-dashboard", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
  };

  pi.on("session_start", async (_event, ctx) => {
    const configResult = loadPantheonConfig(ctx.cwd);
    latestConfig = configResult.config;
    latestWarningCount = configResult.warnings.length;
    autoContinueEnabled = configResult.config.autoContinue?.enabled ?? false;
    autoContinueCount = 0;
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    ctx.ui.setStatus(AUTO_CONTINUE_KEY, autoContinueEnabled ? "Auto-continue: on" : "Auto-continue: off");
    if (process.env[SUBAGENT_ENV] !== "1" && configResult.config.workflow?.persistTodos !== false) {
      const state = readWorkflowState(ctx.cwd, configResult.config);
      if (state.uncheckedTodos.length > 0) {
        ctx.ui.notify(`Pantheon workflow state restored with ${state.uncheckedTodos.length} unchecked todo${state.uncheckedTodos.length === 1 ? "" : "s"}.`, "info");
      }
    }
    if (configResult.warnings.length > 0) {
      ctx.ui.setStatus(CONFIG_WARNING_KEY, `oh-my-opencode-pi config warnings: ${configResult.warnings.length}`);
      ctx.ui.notify(configResult.warnings.join("\n"), "warning");
    } else {
      ctx.ui.setStatus(CONFIG_WARNING_KEY, "oh-my-opencode-pi ready");
    }

    if (poller) clearInterval(poller);
    if (configResult.config.background?.enabled !== false) {
      const taskDir = ensureDir(configResult.config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const refreshTasks = () => {
        reconcileBackgroundTasks(taskDir, configResult.config.multiplexer);
        const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir);
        ctx.ui.setStatus(TASK_STATUS_KEY, summarizeBackgroundCounts(tasks));
        updatePantheonDashboard(ctx, configResult.config);
        for (const task of tasks) {
          if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
            if (notifiedTasks.has(task.id)) continue;
            notifiedTasks.add(task.id);
            if (!configResult.config.multiplexer?.keepPaneOnFinish) closeTmuxPane(task.paneId);
            ctx.ui.notify(
              `Background ${task.agent} ${task.status}: ${task.summary ?? task.id}`,
              task.status === "failed" ? "warning" : "info",
            );
          }
        }
      };
      refreshTasks();
      poller = setInterval(refreshTasks, configResult.config.background?.pollIntervalMs ?? 3000);
    } else {
      updatePantheonDashboard(ctx, configResult.config);
    }
  });

  pi.on("session_shutdown", async () => {
    if (poller) clearInterval(poller);
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "interactive" || event.source === "rpc") {
      autoContinueCount = 0;
      updatePantheonDashboard(ctx);
    }
    return { action: "continue" };
  });

  pi.on("turn_start", async (_event, ctx) => {
    turnFileMutationCount = 0;
    ctx.ui.setStatus(WORKFLOW_GUIDANCE_KEY, "Pantheon phases: scout → plan → implement → verify");
  });

  pi.on("tool_result", async (event, ctx) => {
    if (process.env[SUBAGENT_ENV] === "1") return;
    const config = loadPantheonConfig(ctx.cwd).config;
    const now = Date.now();

    if ((config.workflow?.postFileToolNudges ?? true) && !event.isError && ["edit", "write", "pantheon_ast_grep_replace", "pantheon_lsp_rename"].includes(event.toolName)) {
      turnFileMutationCount += 1;
      ctx.ui.setStatus(WORKFLOW_GUIDANCE_KEY, "After file changes: run diagnostics/tests and verify touched paths.");
      if (turnFileMutationCount === 1 && now - lastGuidanceAt > 1500) {
        lastGuidanceAt = now;
        ctx.ui.notify("Pantheon reminder: after file changes, run diagnostics/tests before wrapping up.", "info");
      }
    }

    if ((config.workflow?.delegateRetryGuidance ?? true) && event.isError && ["pantheon_delegate", "pantheon_council"].includes(event.toolName)) {
      ctx.ui.setStatus(WORKFLOW_GUIDANCE_KEY, "Delegate retry guidance available");
      if (now - lastGuidanceAt > 1500) {
        lastGuidanceAt = now;
        ctx.ui.notify(
          event.toolName === "pantheon_council"
            ? "Pantheon council failed. Retry guidance: narrow the question, switch presets, inspect /pantheon-debug, or ask a single specialist first."
            : "Pantheon delegate failed. Retry guidance: narrow the task, switch specialists, inspect /pantheon-debug, or use pantheon_background for long-running work.",
          "warning",
        );
      }
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const config = loadPantheonConfig(ctx.cwd).config;
    if (process.env[SUBAGENT_ENV] === "1") return;
    const text = event.messages
      .filter((message): message is Message => Boolean(message) && (message as Message).role === "assistant")
      .map((message) => extractTextFromMessage(message))
      .join("\n\n")
      .trim();

    const uncheckedItems = extractUncheckedTodoItems(text);
    if (config.workflow?.persistTodos !== false) {
      updateWorkflowState(ctx.cwd, config, (state) => ({
        ...state,
        uncheckedTodos: uncheckedItems,
        lastAgentSummary: previewText(text, 1200),
      }));
    }

    const unchecked = uncheckedItems.length;
    if (!autoContinueEnabled && unchecked >= (config.workflow?.todoThreshold ?? 3)) {
      ctx.ui.notify("Unchecked todos detected. Consider /pantheon-auto-continue on for batch execution.", "info");
    }
    if (!autoContinueEnabled && config.autoContinue?.autoEnable && unchecked >= (config.autoContinue?.autoEnableThreshold ?? 4)) {
      autoContinueEnabled = true;
      ctx.ui.notify(`Auto-continue enabled (${unchecked} unchecked todos found).`, "info");
    }

    ctx.ui.setStatus(AUTO_CONTINUE_KEY, autoContinueEnabled ? `Auto-continue: on (${autoContinueCount}/${config.autoContinue?.maxContinuations ?? 5})` : "Auto-continue: off");
    updatePantheonDashboard(ctx, config);
    if (!autoContinueEnabled) return;
    if (!hasUncheckedTodos(text)) {
      autoContinueCount = 0;
      updatePantheonDashboard(ctx, config);
      return;
    }
    if (autoContinueCount >= (config.autoContinue?.maxContinuations ?? 5)) {
      ctx.ui.notify("Auto-continue limit reached.", "warning");
      updatePantheonDashboard(ctx, config);
      return;
    }
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    autoContinueTimer = setTimeout(() => {
      autoContinueCount += 1;
      updatePantheonDashboard(ctx, config);
      pi.sendUserMessage("Continue working through the remaining unchecked todos.");
    }, config.autoContinue?.cooldownMs ?? 3000);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const configResult = loadPantheonConfig(ctx.cwd);
    const config = configResult.config;
    const currentDepth = Number(process.env[DEPTH_ENV] ?? "0") || 0;
    if (process.env[SUBAGENT_ENV] === "1") return;
    if (currentDepth >= (config.delegation?.maxDepth ?? 3)) return;
    if (config.appendOrchestratorPrompt === false) return;

    if (event.systemPrompt.includes("Pantheon Delegation for pi")) return;

    let workflowHints = "";
    if (config.workflow?.injectHints !== false) {
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const activeBackgroundTasks = listBackgroundTasks(taskDir).filter((task) => task.status === "queued" || task.status === "running").length;
      const state = config.workflow?.persistTodos !== false ? readWorkflowState(ctx.cwd, config) : undefined;
      workflowHints = buildWorkflowHints(event.prompt, config, activeBackgroundTasks, state);
      if ((state?.uncheckedTodos.length ?? 0) > 0) {
        workflowHints += `\n\n<PantheonWorkflowState>\nPersisted unchecked todos:\n${state!.uncheckedTodos.slice(0, 8).map((item) => `- [ ] ${item}`).join("\n")}\n</PantheonWorkflowState>`;
      }
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}${workflowHints}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit") return;
    const input = event.input as { path?: string; edits?: Array<{ oldText?: string; newText?: string }> };
    if (!input.path || !Array.isArray(input.edits) || input.edits.length === 0) return;

    const rawPath = input.path.startsWith("@") ? input.path.slice(1) : input.path;
    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(ctx.cwd, rawPath);

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch {
      return;
    }

    const rescued = rescueEditSequence(content, input.edits);
    if (rescued.rescuedAny) {
      input.edits = rescued.edits;
      ctx.ui.setStatus("oh-my-opencode-pi-edit-rescue", `Rescued tolerant edit match for ${input.path}`);
    }
  });

  pi.registerCommand("pantheon-agents", {
    description: "List available Pantheon agents",
    handler: async (_args, ctx) => {
      const { agents, projectAgentsDir } = discoverPantheonAgents(ctx.cwd, true);
      const lines = agents.map((agent) => `- ${agent.name} [${agent.source}] — ${agent.description}`);
      if (projectAgentsDir) lines.push(`\nProject overrides: ${projectAgentsDir}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("pantheon", {
    description: "Interactive Pantheon launcher",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pantheon requires interactive mode", "error");
        return;
      }

      const action = await showPantheonSelect(ctx, "Pantheon Command Center", [
        { value: "delegate", label: "Delegate to specialist", description: "Route focused work to Explorer, Librarian, Oracle, Designer, or Fixer." },
        { value: "council", label: "Ask council", description: "Get multiple perspectives and a synthesized recommendation." },
        { value: "resume", label: "Resume prior work", description: "Build a re-entry brief from persisted todos and recent background tasks." },
        { value: "overview", label: "Open overview", description: "See workflow state and background task activity together." },
        { value: "attach", label: "Attach background task pane", description: "Open or reopen a tmux pane for a running task log." },
        { value: "result", label: "Inspect background result", description: "Open the latest result summary for a detached task." },
        { value: "todos", label: "Inspect persisted todos", description: "Review carried-over unchecked tasks from prior work." },
        { value: "retry", label: "Retry background task", description: "Requeue a completed, failed, or cancelled detached task." },
        { value: "spec", label: "Create spec", description: "Run the guided interview flow and draft a spec into the editor." },
        { value: "debug", label: "Inspect debug trace", description: "Open recent foreground delegation/council traces and inspect why they failed." },
        { value: "agents", label: "List agents", description: "Show bundled and override Pantheon specialists." },
        { value: "repo-map", label: "Repository map", description: "Build a quick cartography summary for the current workspace." },
        { value: "skills", label: "Skills setup", description: "Show skill policy guidance and a starter config snippet." },
        { value: "warnings", label: "Show config warnings", description: "Inspect config validation warnings and active presets." },
      ]);
      if (!action) return;

      if (action === "agents") {
        pi.sendUserMessage("/pantheon-agents");
        return;
      }
      if (action === "spec") {
        pi.sendUserMessage("/pantheon-spec");
        return;
      }
      if (action === "debug") {
        pi.sendUserMessage("/pantheon-debug");
        return;
      }
      if (action === "attach") {
        pi.sendUserMessage("/pantheon-attach");
        return;
      }
      if (action === "result") {
        pi.sendUserMessage("/pantheon-result");
        return;
      }
      if (action === "todos") {
        pi.sendUserMessage("/pantheon-todos");
        return;
      }
      if (action === "retry") {
        pi.sendUserMessage("/pantheon-retry");
        return;
      }
      if (action === "overview") {
        pi.sendUserMessage("/pantheon-overview");
        return;
      }
      if (action === "resume") {
        pi.sendUserMessage("/pantheon-resume");
        return;
      }

      if (action === "warnings") {
        const configResult = loadPantheonConfig(ctx.cwd);
        ctx.ui.notify(
          configResult.warnings.length > 0 ? configResult.warnings.join("\n") : "No config warnings.",
          configResult.warnings.length > 0 ? "warning" : "info",
        );
        return;
      }

      if (action === "repo-map") {
        pi.sendUserMessage("Use pantheon_repo_map for the current workspace.");
        return;
      }

      if (action === "skills") {
        pi.sendUserMessage("/pantheon-skills");
        return;
      }

      if (action === "council") {
        const configResult = loadPantheonConfig(ctx.cwd);
        const presetNames = listCouncilPresetNames(configResult.config);
        const preset = await showPantheonSelect(
          ctx,
          "Council preset",
          (presetNames.length > 0 ? presetNames : ["default"]).map((name) => ({ value: name, label: name, description: `Use the ${name} council preset.` })),
        );
        if (!preset) return;
        const question = await ctx.ui.input("Council question", "What should the council evaluate?");
        if (!question?.trim()) return;
        pi.sendUserMessage(`Use pantheon_council with preset \"${preset}\" for this question:\n\n${question}`);
        return;
      }

      const discovery = discoverPantheonAgents(ctx.cwd, true);
      const agentName = await showPantheonSelect(
        ctx,
        "Choose specialist",
        discovery.agents
          .filter((agent) => !["councillor", "council-master"].includes(agent.name))
          .map((agent) => ({ value: agent.name, label: agent.name, description: `${agent.description} [${agent.source}]` })),
      );
      if (!agentName) return;
      const task = await ctx.ui.input("Delegation task", `Task for ${agentName}`);
      if (!task?.trim()) return;
      pi.sendUserMessage(`Use pantheon_delegate with agent \"${agentName}\" for this task:\n\n${task}`);
    },
  });

  pi.registerCommand("pantheon-council", {
    description: "Interactively ask the council",
    handler: async (_args, ctx) => {
      const configResult = loadPantheonConfig(ctx.cwd);
      const presetNames = listCouncilPresetNames(configResult.config);
      const preset = await showPantheonSelect(
        ctx,
        "Council preset",
        (presetNames.length > 0 ? presetNames : ["default"]).map((name) => ({ value: name, label: name, description: `Use the ${name} council preset.` })),
      );
      if (!preset) return;
      const question = await ctx.ui.input("Council question", "What should the council evaluate?");
      if (!question?.trim()) return;
      pi.sendUserMessage(`Use pantheon_council with preset \"${preset}\" for this question:\n\n${question}`);
    },
  });

  pi.registerCommand("pantheon-config", {
    description: "Show oh-my-opencode-pi config sources and warnings",
    handler: async (_args, ctx) => {
      const configResult = loadPantheonConfig(ctx.cwd);
      const councilPresetNames = listCouncilPresetNames(configResult.config);
      const configPresetNames = listConfigPresetNames(configResult);
      const configuredAgents = Object.keys(configResult.config.agents ?? {});
      const lines = [
        `Global config: ${configResult.sources.globalPath}`,
        `Project config: ${configResult.sources.projectPath ?? "(none)"}`,
        `Active config presets: ${configResult.activePresets.join(", ") || "(none)"}`,
        `Available config presets: ${configPresetNames.join(", ") || "(none)"}`,
        `Council presets: ${councilPresetNames.join(", ") || "default"}`,
        `Agent overrides: ${configuredAgents.join(", ") || "(none)"}`,
        `Cartography: ${configResult.config.skills?.cartography?.enabled === false ? "disabled" : "enabled"}`,
        `Default skill allow/deny: ${(configResult.config.skills?.defaultAllow ?? []).join(", ") || "(none)"} / ${(configResult.config.skills?.defaultDeny ?? []).join(", ") || "(none)"}`,
        `Adapter defaults: ${(configResult.config.adapters?.defaultAllow ?? []).join(", ") || "(none)"} / ${(configResult.config.adapters?.defaultDeny ?? []).join(", ") || "(none)"}`,
      ];
      if (configResult.warnings.length > 0) {
        lines.push("", "Warnings:", ...configResult.warnings.map((warning) => `- ${warning}`));
      }
      latestConfig = configResult.config;
      latestWarningCount = configResult.warnings.length;
      updatePantheonDashboard(ctx, configResult.config);
      ctx.ui.notify(lines.join("\n"), configResult.warnings.length > 0 ? "warning" : "info");
    },
  });

  pi.registerCommand("pantheon-skills", {
    description: "Show effective skill/cartography guidance and a starter config snippet",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const snippet = JSON.stringify({
        skills: {
          setupHints: true,
          defaultAllow: ["cartography"],
          cartography: { enabled: true, maxFiles: 250, maxDepth: 4 },
        },
        agents: {
          explorer: { allowSkills: ["cartography"] },
          librarian: { allowedAdapters: ["docs-context7", "github-releases"] },
          fixer: { deniedAdapters: ["grep-app"] },
        },
      }, null, 2);
      const lines = [
        `Cartography: ${config.skills?.cartography?.enabled === false ? "disabled" : "enabled"}`,
        `Default skills allow: ${(config.skills?.defaultAllow ?? []).join(", ") || "(none)"}`,
        `Default skills deny: ${(config.skills?.defaultDeny ?? []).join(", ") || "(none)"}`,
        `Skill setup hints: ${config.skills?.setupHints === false ? "disabled" : "enabled"}`,
        "",
        "Starter config snippet:",
        snippet,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("pantheon-repo-map", {
    description: "Build a repo map / codemap summary for the current workspace",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const result = buildRepoMap(ctx.cwd, {
        maxFiles: config.skills?.cartography?.maxFiles,
        maxDepth: config.skills?.cartography?.maxDepth,
        maxPerDirectory: config.skills?.cartography?.maxPerDirectory,
        exclude: config.skills?.cartography?.exclude,
      });
      ctx.ui.notify(result.text, "info");
    },
  });

  pi.registerCommand("pantheon-adapters", {
    description: "List registered Pantheon research adapters and effective policy for this session",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const { agentName, adapters } = getAllowedAdapters(config);
      const registered = getEffectiveAdapters(config);
      const lines = [
        `Current agent: ${agentName ?? "interactive"}`,
        `Allowed adapters: ${adapters.map((adapter) => adapter.id).join(", ") || "(none)"}`,
        `Registered adapters: ${registered.map((adapter) => `${adapter.id} — ${adapter.description}`).join("\n") || "(none)"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("pantheon-debug-dir", {
    description: "Show the debug log directory for foreground Pantheon traces",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const debugDir = resolveDebugLogDir(ctx.cwd, config);
      ctx.ui.notify(`Pantheon debug dir: ${debugDir}`, "info");
    },
  });

  pi.registerCommand("pantheon-debugs", {
    description: "List recent Pantheon debug traces",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const traces = listDebugTraces(resolveDebugLogDir(ctx.cwd, config)).slice(0, 20);
      if (traces.length === 0) {
        ctx.ui.notify("No Pantheon debug traces found.", "info");
        return;
      }
      ctx.ui.notify(
        traces.map((trace) => `${trace.id} [${String(trace.summary?.status ?? "unknown")}] ${String(trace.summary?.kind ?? "trace")} — ${previewText(JSON.stringify(trace.summary?.params ?? {}), 80)}`).join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("pantheon-debug", {
    description: "Load a Pantheon debug trace into the editor (latest by default)",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const debugDir = resolveDebugLogDir(ctx.cwd, config);
      const traces = listDebugTraces(debugDir);
      if (traces.length === 0) {
        ctx.ui.notify("No Pantheon debug traces found.", "info");
        return;
      }
      let traceId = args.trim();
      if (!traceId && ctx.hasUI) {
        traceId = await showPantheonSelect(
          ctx,
          "Pantheon debug trace",
          traces.slice(0, 20).map((trace) => ({
            value: trace.id,
            label: `${trace.id} · ${String(trace.summary?.kind ?? "trace")}`,
            description: `${String(trace.summary?.status ?? "unknown")} — ${previewText(JSON.stringify(trace.summary?.params ?? {}), 90)}`,
          })),
        ) ?? "";
      }
      const trace = traceId ? traces.find((item) => item.id === traceId) : traces[0];
      if (!trace) {
        ctx.ui.notify(`No Pantheon debug trace found: ${traceId}`, "error");
        return;
      }
      const eventsPath = path.join(debugDir, trace.id, "events.ndjson");
      const eventText = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "(no events file)";
      const summaryText = fs.existsSync(trace.summaryPath) ? fs.readFileSync(trace.summaryPath, "utf8") : "{}";
      ctx.ui.setEditorText(`Trace: ${trace.id}\nDirectory: ${path.join(debugDir, trace.id)}\n\nSummary:\n${summaryText}\n\nEvents:\n${eventText}`);
      ctx.ui.notify(`Loaded debug trace ${trace.id} into editor.`, "info");
    },
  });

  pi.registerCommand("pantheon-auto-continue", {
    description: "Toggle Pantheon auto-continue",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const value = args.trim().toLowerCase();
      if (value === "on" || value === "true") autoContinueEnabled = true;
      else if (value === "off" || value === "false") autoContinueEnabled = false;
      else autoContinueEnabled = !autoContinueEnabled;
      autoContinueCount = 0;
      ctx.ui.setStatus(AUTO_CONTINUE_KEY, autoContinueEnabled ? "Auto-continue: on" : "Auto-continue: off");
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Auto-continue ${autoContinueEnabled ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerCommand("pantheon-spec", {
    description: "Interactive interview to generate a project specification",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pantheon-spec requires interactive mode", "error");
        return;
      }
      const config = loadPantheonConfig(ctx.cwd).config;
      const title = await ctx.ui.input("Spec title", config.interview?.templateTitle ?? "Project Specification");
      if (!title?.trim()) return;
      const objective = await ctx.ui.input("Objective", "What should be built or changed?");
      if (!objective?.trim()) return;
      const users = await ctx.ui.input("Users / Stakeholders", "Who is this for?");
      if (!users?.trim()) return;
      const constraints = await ctx.ui.input("Constraints", "Constraints, risks, non-goals?");
      if (!constraints?.trim()) return;
      const success = await ctx.ui.input("Success Criteria", "How will success be measured?");
      if (!success?.trim()) return;
      const notes = await ctx.ui.input("Additional Notes", "Optional notes");
      ctx.ui.setEditorText(buildInterviewSpec(title.trim(), { objective, users, constraints, success, notes: notes ?? "" }));
      ctx.ui.notify("Specification draft loaded into editor.", "info");
    },
  });

  pi.registerCommand("pantheon-as", {
    description: "Route the next task directly to a Pantheon specialist",
    getArgumentCompletions: (prefix) => {
      const names = ["explorer", "librarian", "oracle", "designer", "fixer", "council"];
      return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      const [agentName, ...taskParts] = args.trim().split(/\s+/).filter(Boolean);
      if (!agentName || taskParts.length === 0) {
        ctx.ui.notify("Usage: /pantheon-as <agent> <task>", "error");
        return;
      }
      pi.sendUserMessage(`Use pantheon_delegate with agent \"${agentName}\" for this task:\n\n${taskParts.join(" ")}`);
    },
  });

  pi.registerCommand("pantheon-backgrounds", {
    description: "List Pantheon background tasks",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir).slice(0, 20);
      if (tasks.length === 0) {
        ctx.ui.notify("No background tasks found.", "info");
        return;
      }
      ctx.ui.notify(tasks.map((task) => `${task.id} [${task.status}] ${task.agent} — ${task.summary ?? previewText(task.task, 80)}`).join("\n"), "info");
    },
  });

  pi.registerCommand("pantheon-attach", {
    description: "Open a tmux pane for a Pantheon background task log",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      let taskId = args.trim();
      if (!taskId && ctx.hasUI) {
        const tasks = listBackgroundTasks(taskDir).slice(0, 20);
        const selected = await showPantheonSelect(
          ctx,
          "Attach background task pane",
          tasks.map((task) => ({ value: task.id, label: `${task.id} · ${task.agent}`, description: `${task.status} — ${previewText(task.task, 90)}` })),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-attach <taskId>", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}`, "error");
        return;
      }
      if (!process.env.TMUX || !config.multiplexer?.tmux) {
        ctx.ui.notify("tmux attach requires running inside tmux with multiplexer.tmux enabled.", "error");
        return;
      }
      const updated = attachBackgroundTaskPane(task, config.multiplexer);
      if (!updated.paneId) {
        ctx.ui.notify(`Unable to open tmux pane for ${updated.id}.`, "error");
        return;
      }
      ctx.ui.notify(`Attached tmux pane ${updated.paneId} for ${updated.id}.`, "info");
    },
  });

  pi.registerCommand("pantheon-cancel", {
    description: "Cancel a Pantheon background task",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      let taskId = args.trim();
      if (!taskId && ctx.hasUI) {
        const tasks = listBackgroundTasks(taskDir).filter((task) => task.status === "queued" || task.status === "running");
        const selected = await showPantheonSelect(
          ctx,
          "Cancel background task",
          tasks.map((task) => ({ value: task.id, label: `${task.id} · ${task.agent}`, description: `${task.status} — ${previewText(task.task, 90)}` })),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-cancel <taskId>", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}`, "error");
        return;
      }
      const updated = cancelBackgroundTask(task, config.multiplexer);
      ctx.ui.notify(`Cancelled ${updated.id}`, "info");
    },
  });

  pi.registerCommand("pantheon-log", {
    description: "Show the log tail for a background task",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      let taskId = args.trim();
      if (!taskId && ctx.hasUI) {
        const tasks = listBackgroundTasks(taskDir).slice(0, 20);
        const selected = await showPantheonSelect(
          ctx,
          "Background task log",
          tasks.map((task) => ({ value: task.id, label: `${task.id} · ${task.agent}`, description: `${task.status} — ${previewText(task.task, 90)}` })),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-log <taskId>", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}`, "error");
        return;
      }
      ctx.ui.setEditorText(tailLog(task.logPath));
      ctx.ui.notify(`Loaded log tail for ${task.id} into editor.`, "info");
    },
  });

  pi.registerCommand("pantheon-result", {
    description: "Show the final result for a background task",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      let taskId = args.trim();
      if (!taskId && ctx.hasUI) {
        const tasks = listBackgroundTasks(taskDir).slice(0, 20);
        const selected = await showPantheonSelect(
          ctx,
          "Background task result",
          tasks.map((task) => ({ value: task.id, label: `${task.id} · ${task.agent}`, description: `${task.status} — ${previewText(task.task, 90)}` })),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-result <taskId>", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}`, "error");
        return;
      }
      const text = [
        `${task.id} [${task.status}] ${task.agent}`,
        task.summary ? `\nSummary:\n${task.summary}` : undefined,
        task.result ? `\nResult:\n${summarizeResult(task.result)}` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n");
      ctx.ui.setEditorText(text);
      ctx.ui.notify(`Loaded result for ${task.id} into editor.`, "info");
    },
  });

  pi.registerCommand("pantheon-todos", {
    description: "Show persisted Pantheon workflow todos",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const state = readWorkflowState(ctx.cwd, config);
      ctx.ui.setEditorText(renderWorkflowState(state));
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Loaded Pantheon workflow state (${state.uncheckedTodos.length} unchecked todo${state.uncheckedTodos.length === 1 ? "" : "s"}).`, "info");
    },
  });

  pi.registerCommand("pantheon-overview", {
    description: "Show combined Pantheon workflow and background overview",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir);
      const state = readWorkflowState(ctx.cwd, config);
      ctx.ui.setEditorText(`${renderBackgroundOverview(tasks)}\n\n---\n\n${renderWorkflowState(state)}`);
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify("Loaded Pantheon overview into editor.", "info");
    },
  });

  pi.registerCommand("pantheon-resume", {
    description: "Show a resume brief from persisted workflow state and recent background tasks",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const tasks = listBackgroundTasks(taskDir);
      const state = readWorkflowState(ctx.cwd, config);
      const text = buildResumeContext(state, tasks);
      ctx.ui.setEditorText(text);
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify("Loaded Pantheon resume context into editor.", "info");
    },
  });

  pi.registerCommand("pantheon-clear-todos", {
    description: "Clear persisted Pantheon workflow todos",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const state = updateWorkflowState(ctx.cwd, config, (current) => ({ ...current, uncheckedTodos: [] }));
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Cleared persisted Pantheon todos. Remaining unchecked: ${state.uncheckedTodos.length}.`, "info");
    },
  });

  pi.registerCommand("pantheon-retry", {
    description: "Retry a Pantheon background task with the same spec",
    handler: async (args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      let taskId = args.trim();
      if (!taskId && ctx.hasUI) {
        const tasks = listBackgroundTasks(taskDir).filter((task) => isTerminalTaskStatus(task.status)).slice(0, 20);
        const selected = await showPantheonSelect(
          ctx,
          "Retry background task",
          tasks.map((task) => ({ value: task.id, label: `${task.id} · ${task.agent}`, description: `${task.status} — ${previewText(task.task, 90)}` })),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-retry <taskId>", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}`, "error");
        return;
      }
      if (!isTerminalTaskStatus(task.status)) {
        ctx.ui.notify(`Task ${task.id} is ${task.status}; retry is only available for terminal tasks.`, "error");
        return;
      }
      const retried = retryBackgroundTask(ctx.cwd, task, {
        taskDir,
        randomId,
        onEnqueue: (taskId) => rememberBackgroundTaskId(ctx.cwd, config, taskId),
      });
      if (!retried) {
        ctx.ui.notify(`Unable to retry ${task.id}: missing or invalid spec.`, "error");
        return;
      }
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Retried ${task.id} as ${retried.id}.`, "info");
    },
  });

  pi.registerCommand("pantheon-cleanup", {
    description: "Remove old completed background task artifacts",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const result = cleanupBackgroundArtifacts(taskDir);
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Removed ${result.removed} old task artifacts. Kept ${result.kept}.`, "info");
    },
  });

  pi.registerTool({
    name: "pantheon_background",
    label: "Pantheon Background",
    description: "Launch a Pantheon specialist in the background and return immediately with a task id.",
    promptSnippet: "Run bounded specialist work in the background when the user wants detached or asynchronous execution.",
    parameters: BackgroundParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background", args as { agent?: string; task?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const currentDepth = Number(process.env[DEPTH_ENV] ?? "0") || 0;
      if (currentDepth >= (config.delegation?.maxDepth ?? 3)) {
        return { content: [{ type: "text", text: `Delegation depth limit reached (${config.delegation?.maxDepth ?? 3}).` }], details: undefined, isError: true };
      }
      if (config.background?.enabled === false) {
        return { content: [{ type: "text", text: "Background tasks are disabled in config." }], details: undefined, isError: true };
      }
      const discovery = discoverPantheonAgents(ctx.cwd, params.includeProjectAgents ?? false);
      const agent = discovery.agents.find((item) => item.name === params.agent);
      if (!agent) {
        return { content: [{ type: "text", text: `Unknown Pantheon agent: ${params.agent}` }], details: undefined, isError: true };
      }
      const record = launchBackgroundTask(ctx.cwd, agent, params.task, params.includeProjectAgents ?? false, params.cwd, {
        taskDir: ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks")),
        randomId,
        currentDepth,
        onEnqueue: (taskId) => rememberBackgroundTaskId(ctx.cwd, config, taskId),
        getPiInvocation,
      });
      updatePantheonDashboard(ctx, config);
      return {
        content: [{ type: "text", text: `${record.status === "queued" ? "Queued" : "Launched"} background task ${record.id} for ${record.agent}. Check with pantheon_background_status.` }],
        details: record,
      };
    },
  });

  pi.registerTool({
    name: "pantheon_background_status",
    label: "Pantheon Background Status",
    description: "Check status of Pantheon background tasks.",
    parameters: BackgroundStatusParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background_status", args as { taskId?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_status", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord[] }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir);
      const selected = params.taskId ? tasks.filter((task) => task.id === params.taskId) : tasks.slice(0, 20);
      updatePantheonDashboard(ctx, config);
      if (selected.length === 0) {
        return { content: [{ type: "text", text: params.taskId ? `No task found: ${params.taskId}` : "No background tasks found." }], details: undefined, isError: Boolean(params.taskId) };
      }
      return {
        content: [{ type: "text", text: selected.map((task) => `${task.id} [${task.status}] ${task.agent} — ${task.summary ?? previewText(task.task, 120)}`).join("\n") }],
        details: selected,
      };
    },
  });

  pi.registerTool({
    name: "pantheon_background_wait",
    label: "Pantheon Background Wait",
    description: "Wait until a Pantheon background task reaches a terminal state or times out.",
    parameters: BackgroundWaitParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background_wait", args as { taskId?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_wait", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const timeoutMs = Math.max(0, Math.floor(params.timeoutMs ?? 60000));
      const pollIntervalMs = Math.max(250, Math.floor(params.pollIntervalMs ?? 1500));
      const startedAt = Date.now();

      while (true) {
        reconcileBackgroundTasks(taskDir, config.multiplexer);
        const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
        if (!task) {
          return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
        }
        if (isTerminalTaskStatus(task.status)) {
          updatePantheonDashboard(ctx, config);
          return {
            content: [{ type: "text", text: `${task.id} finished with status ${task.status}. ${task.summary ?? ""}`.trim() }],
            details: task,
            isError: task.status !== "completed",
          };
        }
        if (Date.now() - startedAt >= timeoutMs) {
          updatePantheonDashboard(ctx, config);
          return {
            content: [{ type: "text", text: `${task.id} did not finish within ${timeoutMs}ms. Current status: ${task.status}.` }],
            details: task,
            isError: true,
          };
        }
        try {
          await sleep(pollIntervalMs, signal);
        } catch {
          updatePantheonDashboard(ctx, config);
          return {
            content: [{ type: "text", text: `Stopped waiting for ${task.id}. Current status: ${task.status}.` }],
            details: task,
            isError: true,
          };
        }
      }
    },
  });

  pi.registerTool({
    name: "pantheon_background_attach",
    label: "Pantheon Background Attach",
    description: "Open or reopen a tmux pane that tails a Pantheon background task log.",
    parameters: BackgroundAttachParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background_attach", args as { taskId?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_attach", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      if (!process.env.TMUX || !config.multiplexer?.tmux) {
        return { content: [{ type: "text", text: "tmux attach requires running inside tmux with multiplexer.tmux enabled." }], details: undefined, isError: true };
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
      }
      const updated = attachBackgroundTaskPane(task, config.multiplexer);
      if (!updated.paneId) {
        return { content: [{ type: "text", text: `Unable to open tmux pane for ${updated.id}.` }], details: undefined, isError: true };
      }
      return { content: [{ type: "text", text: `Attached tmux pane ${updated.paneId} for ${updated.id}.` }], details: updated };
    },
  });

  pi.registerTool({
    name: "pantheon_background_cancel",
    label: "Pantheon Background Cancel",
    description: "Cancel a running Pantheon background task.",
    parameters: BackgroundCancelParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background_cancel", args as { taskId?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_cancel", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
      }
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        return { content: [{ type: "text", text: `Task ${task.id} is already ${task.status}.` }], details: task };
      }
      const updated = cancelBackgroundTask(task, config.multiplexer);
      updatePantheonDashboard(ctx, config);
      return { content: [{ type: "text", text: `Cancelled background task ${updated.id}.` }], details: updated };
    },
  });

  pi.registerTool({
    name: "pantheon_background_log",
    label: "Pantheon Background Log",
    description: "Read the log tail for a Pantheon background task.",
    parameters: BackgroundLogParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
      }
      return {
        content: [{ type: "text", text: tailLog(task.logPath, Math.max(1, Math.floor(params.lines ?? 80))) }],
        details: { taskId: task.id, logPath: task.logPath },
      };
    },
  });

  pi.registerTool({
    name: "pantheon_background_result",
    label: "Pantheon Background Result",
    description: "Get the final result summary for a Pantheon background task.",
    parameters: BackgroundResultParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background_result", args as { taskId?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_result", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
      }
      const logTail = params.includeLogTail ? `\n\nLog tail:\n${tailLog(task.logPath, Math.max(1, Math.floor(params.logLines ?? 60)))}` : "";
      const text = `${task.id} [${task.status}] ${task.agent}\n\nSummary:\n${task.summary ?? "(no summary)"}${task.result ? `\n\nResult:\n${summarizeResult(task.result)}` : ""}${logTail}`;
      return { content: [{ type: "text", text }], details: task, isError: task.status === "failed" || task.status === "cancelled" };
    },
  });

  pi.registerTool({
    name: "pantheon_background_retry",
    label: "Pantheon Background Retry",
    description: "Retry a Pantheon background task using its saved spec.",
    parameters: BackgroundRetryParams,
    renderCall(args, theme) {
      return renderBackgroundToolCall("pantheon_background_retry", args as { taskId?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_retry", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
      if (!task) {
        return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
      }
      if (!isTerminalTaskStatus(task.status)) {
        return { content: [{ type: "text", text: `Task ${task.id} is ${task.status}; retry is only available for terminal tasks.` }], details: undefined, isError: true };
      }
      const retried = retryBackgroundTask(ctx.cwd, task, {
        taskDir,
        randomId,
        onEnqueue: (taskId) => rememberBackgroundTaskId(ctx.cwd, config, taskId),
      });
      if (!retried) {
        return { content: [{ type: "text", text: `Unable to retry ${task.id}: missing or invalid spec.` }], details: undefined, isError: true };
      }
      updatePantheonDashboard(ctx, config);
      return { content: [{ type: "text", text: `Retried ${task.id} as ${retried.id}.` }], details: retried };
    },
  });

  pi.registerTool({
    name: "pantheon_workflow_state",
    label: "Pantheon Workflow State",
    description: "Get, set, or clear persisted Pantheon workflow todos and summary state.",
    parameters: WorkflowStateParams,
    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
      return renderWorkflowToolResult("pantheon_workflow_state", "state", text, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const action = params.action.trim().toLowerCase();
      if (action === "get") {
        const state = readWorkflowState(ctx.cwd, config);
        updatePantheonDashboard(ctx, config);
        return { content: [{ type: "text", text: renderWorkflowState(state) }], details: state };
      }
      if (action === "clear") {
        const state = updateWorkflowState(ctx.cwd, config, (current) => ({ ...current, uncheckedTodos: [], lastAgentSummary: params.summary?.trim() || current.lastAgentSummary }));
        updatePantheonDashboard(ctx, config);
        return { content: [{ type: "text", text: "Cleared persisted Pantheon workflow todos." }], details: state };
      }
      if (action === "set") {
        const state = updateWorkflowState(ctx.cwd, config, (current) => ({
          ...current,
          uncheckedTodos: (params.todos ?? []).map((item) => item.trim()).filter(Boolean),
          lastAgentSummary: params.summary?.trim() || current.lastAgentSummary,
        }));
        updatePantheonDashboard(ctx, config);
        return { content: [{ type: "text", text: `Stored ${state.uncheckedTodos.length} persisted Pantheon todo${state.uncheckedTodos.length === 1 ? "" : "s"}.` }], details: state };
      }
      return { content: [{ type: "text", text: `Unknown action: ${params.action}. Use get, set, or clear.` }], details: undefined, isError: true };
    },
  });

  pi.registerTool({
    name: "pantheon_resume_context",
    label: "Pantheon Resume Context",
    description: "Build a resume brief from persisted workflow state and recent background task history.",
    parameters: ResumeContextParams,
    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
      return renderWorkflowToolResult("pantheon_resume_context", "resume", text, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const tasks = listBackgroundTasks(taskDir);
      const state = readWorkflowState(ctx.cwd, config);
      const text = buildResumeContext(state, tasks, {
        maxTasks: params.maxTasks,
        includeCompletedBackground: params.includeCompletedBackground,
        includeFailedBackground: params.includeFailedBackground,
      });
      return { content: [{ type: "text", text }], details: { state, tasks: tasks.slice(0, Math.max(1, Math.floor(params.maxTasks ?? 6))) } };
    },
  });

  pi.registerTool({
    name: "pantheon_background_overview",
    label: "Pantheon Background Overview",
    description: "Get an aggregated overview of Pantheon background tasks.",
    parameters: BackgroundOverviewParams,
    renderResult(result, options, theme) {
      return renderBackgroundToolResult("pantheon_background_overview", result as { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord[] }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir);
      updatePantheonDashboard(ctx, config);
      return { content: [{ type: "text", text: renderBackgroundOverview(tasks, Math.max(1, Math.floor(params.maxRecent ?? 8))) }], details: tasks.slice(0, Math.max(1, Math.floor(params.maxRecent ?? 8))) };
    },
  });

  pi.registerTool({
    name: "pantheon_auto_continue",
    label: "Pantheon Auto Continue",
    description: "Enable or disable orchestrator auto-continue for unchecked todo lists.",
    parameters: AutoContinueParams,
    renderResult(result, _options, theme) {
      const text = result.content[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
      return renderWorkflowToolResult("pantheon_auto_continue", "toggle", text, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      autoContinueEnabled = params.enabled;
      autoContinueCount = 0;
      ctx.ui.setStatus(AUTO_CONTINUE_KEY, autoContinueEnabled ? "Auto-continue: on" : "Auto-continue: off");
      updatePantheonDashboard(ctx, loadPantheonConfig(ctx.cwd).config);
      return { content: [{ type: "text", text: `Auto-continue ${autoContinueEnabled ? "enabled" : "disabled"}.` }], details: { enabled: autoContinueEnabled } };
    },
  });

  pi.registerTool({
    name: "pantheon_interview_spec",
    label: "Pantheon Interview Spec",
    description: "Generate a structured markdown project specification from guided interview answers.",
    parameters: InterviewParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const title = params.title?.trim() || config.interview?.templateTitle || "Project Specification";
      const spec = buildInterviewSpec(title, {
        objective: params.objective,
        users: params.users,
        constraints: params.constraints,
        success: params.success,
        notes: params.notes ?? "",
      });
      return { content: [{ type: "text", text: spec }], details: { title } };
    },
  });

  pi.registerTool({
    name: "pantheon_lsp_goto_definition",
    label: "Pantheon LSP Definition",
    description: "Locate symbol definitions for TS/JS files using a Pi-native language-service integration.",
    promptSnippet: "Jump to the definition of a symbol in a TypeScript or JavaScript project.",
    parameters: LspPositionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = gotoDefinition(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_lsp_find_references",
    label: "Pantheon LSP References",
    description: "Find symbol references for TS/JS files using a Pi-native language-service integration.",
    promptSnippet: "Find references to a symbol in a TypeScript or JavaScript project.",
    parameters: LspReferencesParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = findReferences(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_lsp_diagnostics",
    label: "Pantheon LSP Diagnostics",
    description: "Read TS/JS diagnostics for a file or the nearest configured project.",
    promptSnippet: "Inspect TypeScript or JavaScript diagnostics before or after edits.",
    parameters: LspDiagnosticsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = getDiagnostics(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result, isError: result.diagnostics.some((diagnostic) => diagnostic.category === "error") };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_lsp_rename",
    label: "Pantheon LSP Rename",
    description: "Preview or apply coordinated TS/JS symbol renames across a project.",
    promptSnippet: "Use coordinated renames instead of ad-hoc text edits when changing a symbol name.",
    parameters: LspRenameParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = renameSymbol(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_ast_grep_search",
    label: "Pantheon AST Search",
    description: "Run structural AST-grep searches against a file or directory.",
    promptSnippet: "Use structural search when plain text grep is too broad or syntax-aware matching matters.",
    parameters: AstGrepSearchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = astGrepSearch(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_ast_grep_replace",
    label: "Pantheon AST Replace",
    description: "Preview or apply structural AST-grep rewrites against a file or directory.",
    promptSnippet: "Use structural replace for syntax-aware transformations instead of brittle text replacement.",
    parameters: AstGrepReplaceParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = astGrepReplace(ctx.cwd, params);
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_repo_map",
    label: "Pantheon Repo Map",
    description: "Build a repository map / codemap summary for reconnaissance and planning.",
    promptSnippet: "Survey project structure, key files, directory hotspots, and entry points before planning large changes.",
    parameters: RepoMapParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const config = loadPantheonConfig(ctx.cwd).config;
        const result = buildRepoMap(ctx.cwd, {
          path: params.path,
          maxFiles: params.maxFiles ?? config.skills?.cartography?.maxFiles,
          maxDepth: params.maxDepth ?? config.skills?.cartography?.maxDepth,
          maxPerDirectory: params.maxPerDirectory ?? config.skills?.cartography?.maxPerDirectory,
          includeHidden: params.includeHidden,
          exclude: config.skills?.cartography?.exclude,
        });
        return { content: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_adapter_list",
    label: "Pantheon Adapter List",
    description: "List registered research adapters and effective permissions for the current agent/session.",
    promptSnippet: "Inspect which structured research adapters are available before choosing a research source.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const { agentName, adapters } = getAllowedAdapters(config);
      const registered = getEffectiveAdapters(config);
      const text = [
        `Current agent: ${agentName ?? "interactive"}`,
        `Allowed adapters: ${adapters.map((adapter) => adapter.id).join(", ") || "(none)"}`,
        "",
        "Registered adapters:",
        ...registered.map((adapter) => `- ${adapter.id}: ${adapter.description}`),
      ].join("\n");
      return { content: [{ type: "text", text }], details: { agentName, allowed: adapters.map((adapter) => adapter.id), registered: registered.map((adapter) => adapter.id) } };
    },
  });

  pi.registerTool({
    name: "pantheon_adapter_search",
    label: "Pantheon Adapter Search",
    description: "Search structured research sources through pluggable adapters such as docs-context7, grep-app, web-search, or github-releases.",
    promptSnippet: "Use the adapter layer when you need a structured docs/code/release source instead of an unscoped web fetch.",
    parameters: AdapterSearchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const config = loadPantheonConfig(ctx.cwd).config;
        const adapterIds = selectAdapterIds(config, params.adapter, params);
        const sections: string[] = [];
        const details: Array<{ adapter: string; details?: unknown }> = [];
        for (const adapterId of adapterIds) {
          const adapter = requireAdapter(config, adapterId);
          const result = await adapter.search(params, config, signal);
          sections.push(`## ${adapter.id}\n${result.text}`);
          details.push({ adapter: adapter.id, details: result.details });
        }
        return { content: [{ type: "text", text: sections.join("\n\n") }], details: { adapters: details } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_adapter_fetch",
    label: "Pantheon Adapter Fetch",
    description: "Fetch content through a specific structured research adapter.",
    promptSnippet: "Fetch documentation, public code search results, or release notes through the adapter system when source choice matters.",
    parameters: AdapterFetchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const config = loadPantheonConfig(ctx.cwd).config;
        const adapter = requireAdapter(config, params.adapter);
        const result = await adapter.fetch(params, config, signal);
        return { content: [{ type: "text", text: result.text }], details: { adapter: adapter.id, details: result.details } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_fetch",
    label: "Pantheon Fetch",
    description: "Fetch and summarize web page text for documentation and research.",
    promptSnippet: "Fetch a URL and extract readable text for research.",
    parameters: FetchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const text = await fetchText(params.url, config.research?.timeoutMs ?? 15000, config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0", signal);
      return { content: [{ type: "text", text: previewText(text, 8000) }], details: { url: params.url } };
    },
  });

  pi.registerTool({
    name: "pantheon_github_file",
    label: "Pantheon GitHub File",
    description: "Fetch a raw file from a public GitHub repository for documentation or example research.",
    promptSnippet: "Read a specific GitHub file when repo-local examples or docs matter.",
    parameters: GithubFileParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const text = await fetchGithubFile(
        params.repo,
        params.path,
        params.ref,
        config.research?.timeoutMs ?? 15000,
        config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
        signal,
        config.research?.githubToken,
      );
      return { content: [{ type: "text", text: previewText(text, 12000) }], details: { repo: params.repo, path: params.path, ref: params.ref ?? "HEAD" } };
    },
  });

  pi.registerTool({
    name: "pantheon_npm_info",
    label: "Pantheon npm Info",
    description: "Fetch npm registry metadata for a package and optional version.",
    promptSnippet: "Check package versions, repository links, and package metadata from npm.",
    parameters: NpmInfoParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const text = await fetchNpmInfo(
        params.package,
        params.version,
        config.research?.timeoutMs ?? 15000,
        config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
        signal,
      );
      return { content: [{ type: "text", text }], details: { package: params.package, version: params.version ?? "latest" } };
    },
  });

  pi.registerTool({
    name: "pantheon_package_docs",
    label: "Pantheon Package Docs",
    description: "Fetch npm package metadata plus README/documentation excerpt for research.",
    promptSnippet: "Inspect package docs and README content when library behavior matters.",
    parameters: PackageDocsParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const text = await fetchPackageDocs(
        params.package,
        params.version,
        config.research?.timeoutMs ?? 15000,
        config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
        signal,
        Math.max(1000, Math.floor(params.maxChars ?? 12000)),
        config.research?.githubToken,
      );
      return { content: [{ type: "text", text }], details: { package: params.package, version: params.version ?? "latest" } };
    },
  });

  pi.registerTool({
    name: "pantheon_resolve_docs",
    label: "Pantheon Resolve Docs",
    description: "Resolve likely documentation sources for a package, repo, or docs site and optionally search by topic.",
    promptSnippet: "Resolve package homepages, docs sites, README sources, and topic-focused docs results before fetching pages blindly.",
    parameters: ResolveDocsParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const resolved = await resolveDocsSources(
        params.package,
        params.version,
        params.repo,
        params.site,
        config.research?.timeoutMs ?? 15000,
        config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
        signal,
      );
      const results = params.topic?.trim()
        ? await webSearchResults(
            params.topic.trim(),
            config.research?.timeoutMs ?? 15000,
            config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
            Math.max(1, Math.floor(params.maxResults ?? 5)),
            signal,
            resolved.docsSite ? "docs" : "github",
            resolved.docsSite,
            resolved.repo,
            resolved.docsSite,
          )
        : [];
      const lines = [
        resolved.packageName ? `Package: ${resolved.packageName}` : undefined,
        resolved.repo ? `Repo: ${resolved.repo}` : undefined,
        resolved.homepage ? `Homepage: ${resolved.homepage}` : undefined,
        resolved.docsSite ? `Docs site: ${resolved.docsSite}` : undefined,
        resolved.candidates.length > 0 ? `\nCandidates:\n${resolved.candidates.map((candidate) => `- ${candidate.label}: ${candidate.url}`).join("\n")}` : undefined,
        results.length > 0 ? `\nTopic results:\n${results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`).join("\n\n")}` : undefined,
      ].filter((line): line is string => Boolean(line));
      return { content: [{ type: "text", text: lines.join("\n") || "No documentation sources resolved." }], details: { resolved, results } };
    },
  });

  pi.registerTool({
    name: "pantheon_fetch_docs",
    label: "Pantheon Fetch Docs",
    description: "Resolve and fetch the most likely documentation content for a package, repo, site, or explicit docs URL.",
    promptSnippet: "Fetch package or framework documentation using docs-aware resolution instead of a raw URL fetch whenever possible.",
    parameters: FetchDocsParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      try {
        const text = await fetchDocsEntry(
          params,
          config.research?.timeoutMs ?? 15000,
          config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
          signal,
          Math.max(1000, Math.floor(params.maxChars ?? 12000)),
        );
        return { content: [{ type: "text", text }], details: { package: params.package, repo: params.repo, site: params.site, topic: params.topic, url: params.url } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_github_releases",
    label: "Pantheon GitHub Releases",
    description: "Fetch recent GitHub releases and release notes for a repository.",
    promptSnippet: "Inspect release notes and changelog-style history from GitHub releases.",
    parameters: GithubReleasesParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const text = await fetchGithubReleases(
        params.repo,
        Math.max(1, Math.floor(params.limit ?? 5)),
        config.research?.timeoutMs ?? 15000,
        config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
        signal,
        config.research?.githubToken,
      );
      return { content: [{ type: "text", text }], details: { repo: params.repo, limit: params.limit ?? 5 } };
    },
  });

  pi.registerTool({
    name: "pantheon_search",
    label: "Pantheon Search",
    description: "Run a lightweight web search for external research.",
    promptSnippet: "Search the web when local repository context is not enough.",
    parameters: SearchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const text = await webSearch(
        params.query,
        config.research?.timeoutMs ?? 15000,
        config.research?.userAgent ?? "oh-my-opencode-pi/0.1.0",
        config.research?.maxResults ?? 5,
        signal,
        params.scope,
        params.site,
        params.repo,
        config.research?.defaultDocsSite,
      );
      return { content: [{ type: "text", text }], details: { query: params.query, scope: params.scope ?? "web", site: params.site, repo: params.repo } };
    },
  });

  pi.registerTool({
    name: "pantheon_delegate",
    label: "Pantheon Delegate",
    description: "Delegate work to Pantheon specialist subagents with isolated context. Supports single, parallel, and chain modes.",
    promptSnippet: "Delegate work to Pantheon specialists: explorer, librarian, oracle, designer, fixer, or council.",
    promptGuidelines: [
      "Use pantheon_delegate when specialized work adds clear value.",
      "Prefer explorer for reconnaissance, oracle for review/architecture, designer for UI/UX, fixer for implementation, librarian for documentation research.",
      "Use tasks for parallel delegation and chain for scout → plan → implement workflows.",
      "Use pantheon_background instead when the work should continue detached from the foreground flow.",
    ],
    parameters: DelegateParams,
    renderCall(args, theme) {
      return renderDelegateCall(args as { agent?: string; task?: string; tasks?: Array<{ agent: string; task: string }>; chain?: Array<{ agent: string; task: string }> }, theme);
    },
    renderResult(result, options, theme) {
      return renderDelegateResult(result as { content: Array<{ type: string; text?: string }>; details?: DelegateDetails }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const includeProjectAgents = params.includeProjectAgents ?? false;
      const config = loadPantheonConfig(ctx.cwd).config;
      const debugTrace = createDebugTrace(ctx.cwd, config, "pantheon_delegate", {
        params,
        cwd: ctx.cwd,
        includeProjectAgents,
      });
      const currentDepth = Number(process.env[DEPTH_ENV] ?? "0") || 0;
      if (currentDepth >= (config.delegation?.maxDepth ?? 3)) {
        updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: "error", error: "depth-limit" });
        return {
          content: [{ type: "text", text: `Delegation depth limit reached (${config.delegation?.maxDepth ?? 3}).` }],
          details: { mode: "single", includeProjectAgents, results: [] },
          isError: true,
        };
      }
      const discovery = discoverPantheonAgents(ctx.cwd, includeProjectAgents);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const details = (mode: DelegateDetails["mode"], results: SingleResult[]): DelegateDetails => ({
        mode,
        includeProjectAgents,
        results,
      });

      if (modeCount !== 1) {
        updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: "error", error: "invalid-mode-count" });
        return {
          content: [{ type: "text", text: "Provide exactly one mode: single (agent+task), parallel (tasks), or chain (chain)." }],
          details: details("single", []),
          isError: true,
        };
      }

      const resolveAgent = (name: string): AgentConfig | undefined => agents.find((agent) => agent.name === name);

      if (params.chain?.length) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const agent = resolveAgent(step.agent);
          if (!agent) {
            updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: "error", error: `unknown-agent:${step.agent}`, mode: "chain", results });
            return {
              content: [{ type: "text", text: `Unknown Pantheon agent: ${step.agent}` }],
              details: details("chain", results),
              isError: true,
            };
          }

          const result = await runSingleAgentWithFallback(
            ctx.cwd,
            agent.name,
            agent,
            step.task.replace(/\{previous\}/g, previousOutput),
            step.cwd,
            i + 1,
            signal,
            (partial) => {
              const current = partial.details?.results?.[0] as SingleResult | undefined;
              if (!current) return;
              onUpdate?.({
                content: partial.content,
                details: details("chain", [...results, current]),
              });
            },
            undefined,
            debugTrace,
            `chain-${agent.name}-${i + 1}`,
          );
          results.push(result);

          if (!isSuccessfulResult(result, { allowEmpty: config.fallback?.retryOnEmpty === false })) {
            updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: "error", mode: "chain", results });
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${summarizeResult(result)}` }],
              details: details("chain", results),
              isError: true,
            };
          }

          previousOutput = summarizeResult(result);
        }

        updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: "completed", mode: "chain", results });
        return {
          content: [{ type: "text", text: summarizeResult(results[results.length - 1]) }],
          details: details("chain", results),
        };
      }

      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: details("parallel", []),
            isError: true,
          };
        }

        const runningResults: SingleResult[] = params.tasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown",
          task: task.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        }));

        const emitParallelUpdate = () => {
          const done = runningResults.filter((result) => result.exitCode !== -1).length;
          const running = runningResults.length - done;
          onUpdate?.({
            content: [{ type: "text", text: `Pantheon parallel: ${done}/${runningResults.length} done, ${running} running...` }],
            details: details("parallel", [...runningResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
          const agent = resolveAgent(task.agent);
          if (!agent) {
            const unknown: SingleResult = {
              agent: task.agent,
              agentSource: "unknown",
              task: task.task,
              exitCode: 1,
              messages: [],
              stderr: `Unknown Pantheon agent: ${task.agent}`,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            };
            appendDebugEvent(debugTrace, "attempt_finish", { agentName: task.agent, attempt: index + 1, error: "unknown-agent" });
            runningResults[index] = unknown;
            emitParallelUpdate();
            return unknown;
          }

          const result = await runSingleAgentWithFallback(
            ctx.cwd,
            agent.name,
            agent,
            task.task,
            task.cwd,
            undefined,
            signal,
            (partial) => {
              const current = partial.details?.results?.[0] as SingleResult | undefined;
              if (!current) return;
              runningResults[index] = current;
              emitParallelUpdate();
            },
            undefined,
            debugTrace,
            `parallel-${index + 1}-${agent.name}`,
          );
          runningResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const allowEmptyResponses = config.fallback?.retryOnEmpty === false;
        const successCount = results.filter((result) => isSuccessfulResult(result, { allowEmpty: allowEmptyResponses })).length;
        const summary = results
          .map((result) => {
            const status = isSuccessfulResult(result, { allowEmpty: allowEmptyResponses })
              ? "ok"
              : result.abortReason
                ? `failed (aborted: ${result.abortReason})`
                : result.stopReason === "aborted"
                  ? "failed (aborted)"
                  : "failed";
            return `- ${result.agent}: ${status} — ${summarizeResult(result).slice(0, 160)}`;
          })
          .join("\n");

        updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: successCount === results.length ? "completed" : "error", mode: "parallel", results });
        return {
          content: [{ type: "text", text: `Pantheon parallel: ${successCount}/${results.length} succeeded\n\n${summary}` }],
          details: details("parallel", results),
          isError: successCount !== results.length,
        };
      }

      const agent = resolveAgent(params.agent!);
      if (!agent) {
        updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: "error", error: `unknown-agent:${params.agent}`, mode: "single" });
        return {
          content: [{ type: "text", text: `Unknown Pantheon agent: ${params.agent}` }],
          details: details("single", []),
          isError: true,
        };
      }

      const result = await runSingleAgentWithFallback(ctx.cwd, agent.name, agent, params.task!, params.cwd, undefined, signal, onUpdate, undefined, debugTrace, `single-${agent.name}`);
      const isError = !isSuccessfulResult(result, { allowEmpty: config.fallback?.retryOnEmpty === false });
      updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: isError ? "error" : "completed", mode: "single", results: [result] });
      const summaryText = result.abortReason
        ? `${summarizeResult(result)}\n\nAbort reason: ${result.abortReason}`
        : summarizeResult(result);
      return {
        content: [{ type: "text", text: summaryText }],
        details: details("single", [result]),
        isError,
      };
    },
  });

  pi.registerTool({
    name: "pantheon_council",
    label: "Pantheon Council",
    description: "Run multiple councillor subagents in parallel and synthesize their answers with a council master.",
    promptSnippet: "Get a multi-model council answer for high-stakes or ambiguous decisions.",
    promptGuidelines: [
      "Use pantheon_council for high-confidence decisions, architecture reviews, or ambiguous trade-offs.",
      "Do not use it for routine tasks when one good answer is enough.",
    ],
    parameters: CouncilParams,
    renderCall(args, theme) {
      return renderCouncilCall(args as { prompt: string; preset?: string }, theme);
    },
    renderResult(result, options, theme) {
      return renderCouncilResult(result as { content: Array<{ type: string; text?: string }>; details?: CouncilRunResult }, Boolean(options.expanded), theme);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const debugTrace = createDebugTrace(ctx.cwd, config, "pantheon_council", {
        params,
        cwd: ctx.cwd,
      });
      try {
        const council = await runCouncil(
          ctx.cwd,
          params.includeProjectAgents ?? false,
          params.prompt,
          params.preset,
          signal,
          onUpdate,
          debugTrace,
        );

        const footer = council.councillors.map((result) => `${result.memberName}: ${result.model ?? "default"}`).join(", ");
        const abortLine = council.master.abortReason ? `\nAbort reason: ${council.master.abortReason}` : "";
        const text = `${summarizeResult(council.master)}${abortLine}\n\n---\nCouncil preset: ${council.preset}\nCouncillors: ${footer}`;
        const masterFailed = !isSuccessfulResult(council.master, { allowEmpty: config.fallback?.retryOnEmpty === false });
        updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: masterFailed ? "error" : "completed", council });

        return {
          content: [{ type: "text", text }],
          details: council,
          isError: masterFailed,
        };
      } catch (error) {
        updateDebugTraceSummary(debugTrace, {
          finishedAt: Date.now(),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });
}
