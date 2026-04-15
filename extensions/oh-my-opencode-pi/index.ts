import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type AgentConfig,
  discoverPantheonAgents,
  loadOrchestratorPrompt,
} from "./agents.js";
import {
  type CouncilMemberConfig,
  type PantheonConfig,
  findNearestProjectPath,
  listConfigPresetNames,
  listCouncilPresetNames,
  loadPantheonConfig,
  resolveAgentAdapterPolicy,
  resolveCouncilPreset,
} from "./config.js";
import {
  attachAllBackgroundTaskPanes,
  attachBackgroundTaskPane,
  buildBackgroundNextSteps,
  cancelBackgroundTask,
  cleanupBackgroundArtifacts,
  closeTmuxPane,
  describeBackgroundTask,
  getMultiplexerWindowName,
  isTaskStale,
  launchBackgroundTask,
  listBackgroundTasks,
  maybeStartQueuedTasks,
  readBackgroundTaskSpec,
  reconcileBackgroundTasks,
  renderBackgroundOverview,
  renderBackgroundResult,
  renderBackgroundWatch,
  renderMultiplexerStatus,
  retryBackgroundTask,
  summarizeBackgroundCounts,
  tailLog,
} from "./background.js";
import {
  getFallbackModels,
  resolveCouncilAttemptTimeoutMs,
  resolveDelegateAttemptTimeoutMs,
  resolveFinalMessageGraceMs,
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
  LspSymbolsParams,
  findImplementations,
  findReferences,
  getDiagnostics,
  getTypeDefinitions,
  gotoDefinition,
  hoverSymbol,
  listSymbols,
  renameSymbol,
} from "./tools/lsp.js";
import { RepoMapParams, buildRepoMap } from "./tools/cartography.js";
import { CodeMapParams, buildCodeMap } from "./tools/codemap.js";
import { ApplyPatchParams, applyUnifiedPatch } from "./tools/patch.js";
import { FormatDocumentParams, OrganizeImportsParams, formatDocument, organizeImports } from "./tools/format.js";
import {
  type DebugTraceContext,
  type SubagentDebugContext,
  appendDebugEvent,
  createDebugTrace,
  createSubagentDebugContext,
  listDebugTraces,
  resolveDebugLogDir,
  updateDebugTraceSummary,
  writeDebugJson,
  writeDebugText,
} from "./debug.js";
import {
  classifyFailureKind,
  readPantheonStats,
  recordAdapterUsage,
  recordBackgroundStatus,
  recordCategoryRun,
  recordToolRun,
  renderPantheonStats,
} from "./stats.js";
import { readPantheonEvaluationReport } from "./evals.js";
import type { BackgroundTaskRecord, BackgroundTaskSpec, SingleResult } from "./types.js";
import {
  buildResumeContext,
  buildWorkflowHints,
  extractUncheckedTodoItems,
  hasUncheckedTodos,
  readWorkflowState,
  renderWorkflowState,
  type WorkflowState,
  updateWorkflowState,
} from "./workflow.js";
import { bootstrapPantheonProject, buildBootstrapGuide, buildSpecStudioTemplate } from "./setup.js";
import {
  PantheonOrchestrationRuntime,
  restorePantheonOrchestrationFromEntries,
  summarizeOrchestrationSnapshot,
} from "./orchestration.js";
import {
  buildPantheonDashboardLines,
  getTaskStateChip,
  type PantheonSubagentInspectorSnapshot,
  type RenderTheme,
  renderBackgroundToolCall,
  renderBackgroundToolResult,
  renderPantheonCommandMessage,
  renderWorkflowToolResult,
  showPantheonReportModal,
  showPantheonSelect,
  showPantheonSidebar,
  showPantheonSubagentInspector,
} from "./ui.js";
import {
  renderAdapterSelectionReport,
  selectAdapterIds,
  summarizeAdapterSearchSections,
  type AdapterInvocationLike as AdapterInvocationParams,
} from "./adapter-selection.js";
import { buildAdapterPolicyReport, buildConfigReport, buildDoctorReport } from "./reports.js";
import { auditPantheonProviderConfiguration } from "./doctor.js";
import {
  PANTHEON_COMMAND_MESSAGE_TYPE,
  presentPantheonCommandEditorOutput as presentPantheonCommandEditorOutputBase,
  presentPantheonCommandProgress as presentPantheonCommandProgressBase,
  presentPantheonCommandResult as presentPantheonCommandResultBase,
} from "./presentation.js";
import { smartFetch } from "./smartfetch.js";
import { checkForPackageUpdates, renderPackageUpdateReport } from "./update-checker.js";
import { PANTHEON_USER_AGENT } from "./metadata.js";
import { registerPantheonNamedCommands } from "./command-registry.js";
import { registerPantheonCodeTools } from "./tool-registry.js";
import {
  buildPantheonActivityDescription,
  buildPantheonAgentsReport,
  buildPantheonDelegateRationale,
  buildPantheonQuickHelpReport,
  buildPantheonSpecialistPickerDescription,
  buildPantheonSpecialistPickerLabel,
  buildPantheonSubagentInspectorLabel,
  describePantheonSpecialist,
  getPantheonSpecialistGuide,
} from "./specialists.js";

export { selectAdapterIds, summarizeAdapterSearchSections } from "./adapter-selection.js";

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

interface SubagentActivityState {
  title: string;
  subtitle?: string;
  entries: Array<{ label: string; result: SingleResult }>;
  updatedAt: number;
}

type ReviewMode = "uncommitted" | "committed" | "commit" | "pr";

interface ReviewCommandRequest {
  mode: ReviewMode;
  target?: string;
  label: string;
  commands: string[];
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const SUBAGENT_ENV = "OH_MY_OPENCODE_PI_SUBAGENT";
const DEPTH_ENV = "OH_MY_OPENCODE_PI_DEPTH";
const AGENT_ENV = "OH_MY_OPENCODE_PI_AGENT";
const CONFIG_WARNING_KEY = "oh-my-opencode-pi-config-warning";
const TASK_STATUS_KEY = "oh-my-opencode-pi-task-status";
const AUTO_CONTINUE_KEY = "oh-my-opencode-pi-auto-continue";
const WORKFLOW_GUIDANCE_KEY = "oh-my-opencode-pi-workflow-guidance";
const SUBAGENT_ACTIVITY_KEY = "oh-my-opencode-pi-subagent-activity";
const COMMAND_PROGRESS_STATUS_KEY = "oh-my-opencode-pi-command-progress";
const VERSION_STATUS_KEY = "oh-my-opencode-pi-version";
const SUBAGENT_DETAIL_SUMMARY_PREVIEW_BYTES = 24 * 1024;
const SUBAGENT_DETAIL_LOG_PREVIEW_BYTES = 48 * 1024;
let latestSubagentActivity: SubagentActivityState | undefined;

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

function isLikelyFinalAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant") return false;
  if (!extractTextFromMessage(message)) return false;
  return Boolean(message.stopReason && !["aborted", "error", "tool_use"].includes(message.stopReason));
}

function previewText(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

const REVIEW_MODES: ReviewMode[] = ["uncommitted", "committed", "commit", "pr"];

const REVIEW_COMMAND_USAGE = [
  "Usage: /review <uncommitted|committed [range]|commit [sha]|pr [number|url|branch]>",
  "Examples:",
  "- /review uncommitted",
  "- /review committed HEAD~3..HEAD",
  "- /review commit abc123",
  "- /review pr 42",
].join("\n");

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseReviewCommandRequest(args: string): { request?: ReviewCommandRequest; error?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { error: REVIEW_COMMAND_USAGE };

  const [rawMode, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const mode = rawMode?.toLowerCase() as ReviewMode | undefined;
  const rawTarget = rest.join(" ").trim();

  if (!mode || !REVIEW_MODES.includes(mode)) {
    return { error: REVIEW_COMMAND_USAGE };
  }

  if (mode === "uncommitted") {
    if (rawTarget) {
      return { error: "Usage: /review uncommitted" };
    }
    return {
      request: {
        mode,
        label: "uncommitted local changes (staged + unstaged)",
        commands: [
          "git status --short",
          "git --no-pager diff --stat --cached",
          "git --no-pager diff --cached",
          "git --no-pager diff --stat",
          "git --no-pager diff",
        ],
      },
    };
  }

  if (mode === "committed") {
    const range = rawTarget || "HEAD~1..HEAD";
    return {
      request: {
        mode,
        target: range,
        label: `committed range ${range}`,
        commands: [
          `git --no-pager diff --stat ${shellQuote(range)}`,
          `git --no-pager diff ${shellQuote(range)}`,
        ],
      },
    };
  }

  if (mode === "commit") {
    const commit = rawTarget || "HEAD";
    return {
      request: {
        mode,
        target: commit,
        label: `commit ${commit}`,
        commands: [
          `git --no-pager show --stat --format=fuller ${shellQuote(commit)}`,
          `git --no-pager show --format=fuller ${shellQuote(commit)}`,
        ],
      },
    };
  }

  const prTarget = rawTarget;
  const prSuffix = prTarget ? ` ${shellQuote(prTarget)}` : "";
  return {
    request: {
      mode,
      target: prTarget || undefined,
      label: prTarget ? `pull request ${prTarget}` : "current pull request",
      commands: [
        `gh pr view${prSuffix} --json number,title,body,baseRefName,headRefName,author,state,mergeable,url`,
        `gh pr diff${prSuffix}`,
      ],
    },
  };
}

async function resolveReviewCommandRequest(args: string, ctx: ExtensionContext): Promise<{ request?: ReviewCommandRequest; error?: string }> {
  if (args.trim()) return parseReviewCommandRequest(args);
  if (!ctx.hasUI) return { error: REVIEW_COMMAND_USAGE };

  const mode = await showPantheonSelect(ctx, "Review code changes", [
    { value: "uncommitted", label: "uncommitted", description: "Review staged and unstaged local changes." },
    { value: "committed", label: "committed", description: "Review a committed diff range (defaults to HEAD~1..HEAD)." },
    { value: "commit", label: "commit", description: "Review a specific commit (defaults to HEAD)." },
    { value: "pr", label: "pr", description: "Review a pull request with gh pr diff." },
  ]);
  if (!mode) return {};

  if (mode === "uncommitted") return parseReviewCommandRequest(mode);

  const input = await ctx.ui.input(
    mode === "committed" ? "Committed range" : mode === "commit" ? "Commit SHA" : "PR number, URL, or branch (optional)",
    mode === "committed" ? "HEAD~1..HEAD" : mode === "commit" ? "HEAD" : "",
  );
  if (input == null) return {};
  return parseReviewCommandRequest(input.trim() ? `${mode} ${input.trim()}` : mode);
}

function buildReviewCommandPrompt(request: ReviewCommandRequest, cwd: string): string {
  const lines = [
    "Act as a senior code reviewer and review the requested code changes for production readiness.",
    "",
    "Model this review on obra/superpowers' code-reviewer workflow: inspect the diff directly, calibrate severity carefully, and finish with a clear merge verdict.",
    "",
    "Review target:",
    `- Mode: ${request.mode}`,
    `- Scope: ${request.label}`,
    `- Workspace: ${cwd}`,
    ...(request.target ? [`- Target: ${request.target}`] : []),
    "",
    "First inspect the changes directly with bash before drawing conclusions. Do not rely only on summaries or prior conversation.",
    "Use these commands:",
    ...request.commands.map((command) => `- ${command}`),
    ...(request.mode === "pr"
      ? ["- If `gh` is unavailable or unauthenticated, say so clearly before giving a partial review."]
      : []),
    "",
    "Review checklist:",
    "- Correctness, regressions, and edge cases",
    "- Security, privacy, and data-loss risks",
    "- Performance and unnecessary complexity",
    "- Test coverage and validation gaps",
    "- Docs, config, migration, or rollout impacts",
    "- Whether the implementation matches the apparent intent of the changes",
    "",
    "When you find issues:",
    "- Cite file:line references whenever possible",
    "- Explain why the issue matters",
    "- Suggest a concrete fix when it is not obvious",
    "- Calibrate severity as Critical, Important, or Minor",
    "",
    "Output format:",
    "### Strengths",
    "[Specific things done well, or `None` if there are no notable strengths.]",
    "",
    "### Issues",
    "",
    "#### Critical (Must Fix)",
    "[Bugs, security issues, broken behavior, or data-loss risks. Use `None` if empty.]",
    "",
    "#### Important (Should Fix)",
    "[Correctness gaps, risky behavior, missing tests, or maintainability issues. Use `None` if empty.]",
    "",
    "#### Minor (Nice to Have)",
    "[Polish, cleanup, or optional improvements. Use `None` if empty.]",
    "",
    "### Recommendations",
    "[Concrete follow-ups, simplifications, or safeguards.]",
    "",
    "### Assessment",
    "",
    "**Ready to merge?** [Yes/No/With fixes]",
    "",
    "**Reasoning:** [1-2 sentence technical assessment]",
  ];

  return lines.join("\n");
}

function resolveBackgroundLogDir(cwd: string, config: PantheonConfig): string {
  const configured = config.background?.logDir?.trim() || path.join(getAgentDir(), ".oh-my-opencode-pi-tasks");
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

function resolveWorkflowStatePath(cwd: string, config: PantheonConfig): string {
  const configured = config.workflow?.stateFile?.trim() || ".oh-my-opencode-pi-workflow.json";
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

function isTmuxBinaryAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

async function streamPantheonCommandProgress(
  command: string,
  summaryPrefix: string,
  executor: (onUpdate: (partial: AgentToolResult<any>) => void) => Promise<AgentToolResult<any>>,
  ctx: ExtensionContext,
  onProgress: (command: string, partial: AgentToolResult<any>, ctx: ExtensionContext, summary: string) => void,
): Promise<AgentToolResult<any>> {
  let updateCount = 0;
  return executor((partial) => {
    updateCount += 1;
    onProgress(command, partial, ctx, `${summaryPrefix} (update ${updateCount})`);
    ctx.ui.setStatus(COMMAND_PROGRESS_STATUS_KEY, `${command} streaming… ${updateCount}`);
  }).finally(() => {
    ctx.ui.setStatus(COMMAND_PROGRESS_STATUS_KEY, undefined);
  });
}

function getResultState(result: SingleResult): { icon: string; color: "success" | "warning" | "error" } {
  if (result.exitCode === -1) return { icon: "…", color: "warning" };
  if (result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted") {
    return { icon: "✓", color: "success" };
  }
  return { icon: "✗", color: "error" };
}

function formatElapsed(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 6) / 10;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours}h`;
}

function formatResultLine(result: SingleResult, theme: RenderTheme, maxPreview = 120): string {
  const state = getResultState(result);
  const model = result.model ? theme.fg("muted", ` (${previewText(result.model, 28)})`) : "";
  const source = result.agentSource !== "unknown" ? theme.fg("dim", ` [${result.agentSource}]`) : "";
  const duration = formatElapsed(result.durationMs ?? (typeof result.startedAt === "number" && result.exitCode === -1 ? Date.now() - result.startedAt : undefined));
  const durationChip = duration ? theme.fg("dim", ` ${duration}`) : "";
  const reason = result.abortReason
    ? theme.fg("warning", ` aborted:${previewText(result.abortReason, 32)}`)
    : result.stopReason === "aborted"
      ? theme.fg("warning", " aborted")
      : result.stopReason === "error"
        ? theme.fg("error", " error")
        : "";
  return `${theme.fg(state.color, state.icon)} ${theme.fg("accent", `${result.agent}${result.step ? ` #${result.step}` : ""}`)}${model}${source}${durationChip}${reason} ${theme.fg("muted", "—")} ${previewText(summarizeResult(result), maxPreview)}`;
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

function buildSubagentActivityPreview(result: SingleResult): string {
  const summary = summarizeResult(result);
  const duration = formatElapsed(result.durationMs ?? (typeof result.startedAt === "number" && result.exitCode === -1 ? Date.now() - result.startedAt : undefined));
  const body = summary !== "(no output)" ? previewText(summary, 120) : result.exitCode === -1 ? "waiting for output…" : summary;
  const preview = duration ? `${body} (${duration})` : body;
  return buildPantheonActivityDescription(result.agent, preview);
}

function getSubagentStatusLabel(result: SingleResult): string {
  if (result.exitCode === -1) return "running";
  if (result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted") return "completed";
  if (result.abortReason || result.stopReason === "aborted") return "aborted";
  return "failed";
}

function collectPreviewLines(text: string, maxLines: number, mode: "head" | "tail" = "tail"): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= maxLines) return lines;
  return mode === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines);
}

function appendParsedOutputChunk(chunks: string[], text: string | undefined): void {
  const clean = text?.trim();
  if (!clean) return;
  if (chunks[chunks.length - 1]?.trim() === clean) return;
  chunks.push(clean);
}

function extractStreamTextCandidate(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const textValue = (value as { text?: unknown }).text;
  return typeof textValue === "string" ? textValue : "";
}

function extractParsedOutputFromEvent(event: any): { chunks: string[]; streamText?: string; clearStream?: boolean } {
  const chunks: string[] = [];

  if (event?.type === "message_end" && event.message) {
    appendParsedOutputChunk(chunks, extractTextFromMessage(event.message as Message));
    return { chunks, clearStream: true };
  }

  if (event?.type === "tool_result_end" && event.message) {
    appendParsedOutputChunk(chunks, extractTextFromMessage(event.message as Message));
    return { chunks };
  }

  if (event?.type === "content_block_start") {
    const text = extractStreamTextCandidate(event.contentBlock ?? event.content_block ?? event.block);
    return text ? { chunks, streamText: text } : { chunks };
  }

  if (event?.type === "content_block_delta" || event?.type === "message_delta") {
    const delta = event.delta ?? event.message?.delta ?? event.contentBlockDelta;
    const text = extractStreamTextCandidate(delta);
    return text ? { chunks, streamText: text } : { chunks };
  }

  return { chunks };
}

function parseSubagentOutputPreview(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const prefix: string[] = [];
  let streamText = "";
  const chunks: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[truncated:")) {
      prefix.push(trimmed);
      continue;
    }

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const parsed = extractParsedOutputFromEvent(event);
    if (parsed.streamText) streamText += parsed.streamText;
    for (const chunk of parsed.chunks) appendParsedOutputChunk(chunks, chunk);
    if (parsed.clearStream) streamText = "";
  }

  appendParsedOutputChunk(chunks, streamText);
  return [...prefix, ...chunks].join("\n\n").trim();
}

function readSubagentOutputPreview(
  result: SingleResult,
  fallback: string,
  options?: { maxBytes?: number; mode?: "head" | "tail" },
): string {
  if (!result.debugStdoutPath) return fallback;
  const rawPreview = readDebugArtifactPreview(result.debugStdoutPath, "", options);
  const parsedPreview = parseSubagentOutputPreview(rawPreview);
  return parsedPreview || fallback;
}

function buildSubagentExpandedLines(entry: { label: string; result: SingleResult }, options?: { stdoutLines?: number; stderrLines?: number }): string[] {
  const result = entry.result;
  const guide = getPantheonSpecialistGuide(result.agent);
  const statusParts = [getSubagentStatusLabel(result)];
  if (result.model) statusParts.push(`model ${previewText(result.model, 40)}`);
  const duration = formatElapsed(result.durationMs ?? (typeof result.startedAt === "number" && result.exitCode === -1 ? Date.now() - result.startedAt : undefined));
  if (duration) statusParts.push(duration);

  const summary = summarizeResult(result);
  const lines = [
    guide && !guide.internal ? `specialist: ${guide.roleSummary}` : undefined,
    guide && !guide.internal ? `why: ${guide.rationale}` : undefined,
    `task: ${previewText(result.task, 140)}`,
    `status: ${statusParts.join(" • ")}`,
    `summary: ${previewText(summary, 180)}`,
  ].filter((line): line is string => Boolean(line));

  const outputPreview = readSubagentOutputPreview(
    result,
    result.exitCode === -1 && summary === "(no output)" ? "waiting for output…" : summary,
    { maxBytes: SUBAGENT_DETAIL_LOG_PREVIEW_BYTES, mode: "tail" },
  );
  const outputLines = collectPreviewLines(outputPreview, Math.max(2, options?.stdoutLines ?? 4));
  if (outputLines.length > 0) lines.push(`output: ${outputLines.join(" ⏎ ")}`);

  const stderrText = result.debugStderrPath
    ? readDebugArtifactPreview(result.debugStderrPath, result.stderr || "", { maxBytes: SUBAGENT_DETAIL_LOG_PREVIEW_BYTES, mode: "tail" })
    : result.stderr;
  const stderrLines = collectPreviewLines(stderrText || "", Math.max(1, options?.stderrLines ?? 2));
  if (stderrLines.length > 0) lines.push(`stderr: ${stderrLines.join(" ⏎ ")}`);

  return lines;
}

function buildSubagentInspectorSnapshot(activity: SubagentActivityState | undefined): PantheonSubagentInspectorSnapshot | undefined {
  if (!activity || activity.entries.length === 0) return undefined;
  return {
    title: activity.title,
    subtitle: activity.subtitle,
    entries: activity.entries.map((entry) => ({
      label: buildPantheonSubagentInspectorLabel(entry.label, entry.result.agent),
      description: buildSubagentActivityPreview(entry.result),
      expandedLines: buildSubagentExpandedLines(entry, { stdoutLines: 5, stderrLines: 3 }),
      traceAvailable: Boolean(entry.result.debugTraceId),
    })),
  };
}

function renderSubagentActivityLines(
  ctx: ExtensionContext,
  options: {
    title: string;
    subtitle?: string;
    entries: Array<{ label: string; result: SingleResult }>;
  },
): string[] {
  const fg = ctx.ui?.theme?.fg?.bind(ctx.ui.theme) ?? ((_color: string, text: string) => text);
  const bold = ctx.ui?.theme?.bold?.bind(ctx.ui.theme) ?? ((text: string) => text);
  const theme = { fg, bold };
  const lines = [
    `${fg("accent", bold(options.title))}${options.subtitle ? fg("dim", ` • ${options.subtitle}`) : ""}`,
  ];
  if (options.entries.length === 0) {
    lines.push(fg("dim", "Waiting for subagent activity…"));
    return lines;
  }

  const allCouncilMembers = options.entries.length > 0 && options.entries.every((entry) => entry.result.agent === "councillor");
  const allCouncilComplete = options.entries.length > 0 && options.entries.every((entry) => ["councillor", "council-master"].includes(entry.result.agent));
  if (allCouncilMembers && options.subtitle?.includes("member perspectives")) {
    lines.push(fg("dim", `${options.entries.length} council member perspective${options.entries.length === 1 ? "" : "s"} ready`));
    lines.push(fg("dim", "Inspect live detail: /pantheon-subagents"));
    return lines;
  }
  if (allCouncilComplete && options.subtitle?.includes("complete")) {
    const memberCount = options.entries.filter((entry) => entry.result.agent === "councillor").length;
    const synthesisReady = options.entries.some((entry) => entry.result.agent === "council-master");
    lines.push(fg("success", `${memberCount} council member perspective${memberCount === 1 ? "" : "s"} ready${synthesisReady ? " + synthesis ready" : ""}`));
    lines.push(fg("dim", "Inspect live detail: /pantheon-subagents"));
    return lines;
  }

  for (const entry of options.entries) {
    const state = getResultState(entry.result);
    lines.push(
      `${theme.fg(state.color, state.icon)} ${theme.fg("accent", entry.label)} ${theme.fg("muted", "—")} ${theme.fg("muted", buildSubagentActivityPreview(entry.result))}`,
    );
    const rationale = buildPantheonDelegateRationale(entry.result.agent);
    const guide = getPantheonSpecialistGuide(entry.result.agent);
    if (rationale && !guide?.internal && options.entries.length <= 2) {
      lines.push(`  ${theme.fg("dim", "why:")} ${theme.fg("muted", rationale)}`);
    }
  }
  lines.push(fg("dim", "Inspect live detail: /pantheon-subagents"));
  return lines;
}

function formatByteSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function getDebugArtifactSize(filePath: string | undefined): number | undefined {
  if (!filePath) return undefined;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

function buildDebugArtifactDescription(
  filePath: string | undefined,
  options?: { maxBytes?: number; mode?: "head" | "tail"; missingDescription?: string },
): string {
  const size = getDebugArtifactSize(filePath);
  if (size == null) return options?.missingDescription ?? "not available";
  const maxBytes = Math.max(1024, Math.floor(options?.maxBytes ?? SUBAGENT_DETAIL_LOG_PREVIEW_BYTES));
  if (size <= maxBytes) return `${path.basename(filePath!)} • ${formatByteSize(size)} • full preview`;
  return `${path.basename(filePath!)} • ${formatByteSize(size)} • ${options?.mode === "tail" ? "tail" : "head"} preview capped at ${formatByteSize(maxBytes)}`;
}

function readDebugArtifactPreview(
  filePath: string | undefined,
  fallback: string,
  options?: { maxBytes?: number; mode?: "head" | "tail" },
): string {
  if (!filePath) return fallback;
  try {
    const stats = fs.statSync(filePath);
    const maxBytes = Math.max(1024, Math.floor(options?.maxBytes ?? SUBAGENT_DETAIL_LOG_PREVIEW_BYTES));
    if (stats.size <= maxBytes) return fs.readFileSync(filePath, "utf8");

    const start = options?.mode === "tail" ? Math.max(0, stats.size - maxBytes) : 0;
    const length = Math.min(maxBytes, stats.size - start);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const excerpt = buffer.toString("utf8");
      const label = options?.mode === "tail" ? "last" : "first";
      return [`[truncated: showing ${label} ${length} bytes of ${stats.size} from ${filePath}]`, excerpt].join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return fallback;
  }
}

function buildSubagentArtifactText(
  entry: { label: string; result: SingleResult },
  artifactLabel: string,
  filePath: string | undefined,
  fallback: string,
  options?: { maxBytes?: number; mode?: "head" | "tail" },
): string {
  const guide = getPantheonSpecialistGuide(entry.result.agent);
  return [
    `Subagent: ${entry.label}`,
    `Agent: ${entry.result.agent}`,
    guide && !guide.internal ? `Specialist: ${guide.roleSummary}` : undefined,
    guide && !guide.internal ? `Why selected: ${guide.rationale}` : undefined,
    `Artifact: ${artifactLabel}`,
    filePath ? `Path: ${filePath}` : undefined,
    `Preview: ${buildDebugArtifactDescription(filePath, options)}`,
    "",
    readDebugArtifactPreview(filePath, fallback, options),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function buildSubagentOutputText(
  entry: { label: string; result: SingleResult },
  options?: { maxBytes?: number; mode?: "head" | "tail" },
): string {
  const summary = summarizeResult(entry.result);
  const guide = getPantheonSpecialistGuide(entry.result.agent);
  return [
    `Subagent: ${entry.label}`,
    `Agent: ${entry.result.agent}`,
    guide && !guide.internal ? `Specialist: ${guide.roleSummary}` : undefined,
    guide && !guide.internal ? `Why selected: ${guide.rationale}` : undefined,
    "Artifact: Output",
    entry.result.debugStdoutPath ? `Path: ${entry.result.debugStdoutPath}` : undefined,
    `Preview: ${buildDebugArtifactDescription(entry.result.debugStdoutPath, options)}`,
    "",
    readSubagentOutputPreview(
      entry.result,
      entry.result.exitCode === -1 && summary === "(no output)" ? "waiting for output…" : summary,
      options,
    ),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function buildSubagentPathsText(entry: { label: string; result: SingleResult }): string {
  const result = entry.result;
  const guide = getPantheonSpecialistGuide(result.agent);
  return [
    `Subagent: ${entry.label}`,
    `Agent: ${result.agent}`,
    guide && !guide.internal ? `Specialist: ${guide.roleSummary}` : undefined,
    guide && !guide.internal ? `Why selected: ${guide.rationale}` : undefined,
    result.debugTraceId ? `Trace: ${result.debugTraceId}` : undefined,
    result.debugDir ? `Debug dir: ${result.debugDir}` : undefined,
    result.debugSummaryPath ? `Summary JSON: ${result.debugSummaryPath}` : undefined,
    result.debugStdoutPath ? `Stdout: ${result.debugStdoutPath}` : undefined,
    result.debugStderrPath ? `Stderr: ${result.debugStderrPath}` : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function buildSubagentDetailText(entry: { label: string; result: SingleResult }): string {
  const result = entry.result;
  const guide = getPantheonSpecialistGuide(result.agent);
  const summary = summarizeResult(result);
  return [
    `Subagent: ${entry.label}`,
    `Agent: ${result.agent}`,
    guide && !guide.internal ? `Specialist: ${guide.roleSummary}` : undefined,
    guide && !guide.internal ? `Best for: ${guide.bestFor}` : undefined,
    guide && !guide.internal ? `Why selected: ${guide.rationale}` : undefined,
    `Status: ${result.exitCode === -1 ? "running" : result.exitCode === 0 ? "completed" : "failed"}`,
    result.model ? `Model: ${result.model}` : undefined,
    result.startedAt ? `Started: ${new Date(result.startedAt).toISOString()}` : undefined,
    result.finishedAt ? `Finished: ${new Date(result.finishedAt).toISOString()}` : undefined,
    formatElapsed(result.durationMs) ? `Duration: ${formatElapsed(result.durationMs)}` : undefined,
    result.debugTraceId ? `Trace: ${result.debugTraceId}` : undefined,
    result.debugDir ? `Debug dir: ${result.debugDir}` : undefined,
    result.debugSummaryPath ? `Summary JSON path: ${result.debugSummaryPath}` : undefined,
    result.debugStdoutPath ? `Stdout path: ${result.debugStdoutPath}` : undefined,
    result.debugStderrPath ? `Stderr path: ${result.debugStderrPath}` : undefined,
    `Task: ${result.task}`,
    "",
    "Summary:",
    summary,
    "",
    "Output:",
    readSubagentOutputPreview(result, result.exitCode === -1 && summary === "(no output)" ? "waiting for output…" : summary, { maxBytes: SUBAGENT_DETAIL_LOG_PREVIEW_BYTES, mode: "tail" }),
    "",
    "Stderr:",
    result.debugStderrPath
      ? readDebugArtifactPreview(result.debugStderrPath, result.stderr || "(no stderr log)", { maxBytes: SUBAGENT_DETAIL_LOG_PREVIEW_BYTES, mode: "tail" })
      : (result.stderr || "(no stderr log)"),
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function setSubagentActivityWidget(
  ctx: ExtensionContext,
  options: {
    title: string;
    subtitle?: string;
    entries: Array<{ label: string; result: SingleResult }>;
  },
): void {
  latestSubagentActivity = { ...options, updatedAt: Date.now() };
  if (!ctx.ui?.setWidget) return;
  ctx.ui.setWidget(SUBAGENT_ACTIVITY_KEY, renderSubagentActivityLines(ctx, options), { placement: "belowEditor" });
}

function clearSubagentActivityWidget(ctx: ExtensionContext, clearState = false): void {
  if (clearState) latestSubagentActivity = undefined;
  if (!ctx.ui?.setWidget) return;
  ctx.ui.setWidget(SUBAGENT_ACTIVITY_KEY, undefined);
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
      ...args.chain.slice(0, 5).map((step, index) => `  ${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", buildPantheonSpecialistPickerLabel(step.agent))} ${theme.fg("muted", previewText(step.task, 72))}`),
    ];
    if (args.chain.length > 5) lines.push(`  ${theme.fg("muted", `… +${args.chain.length - 5} more`)}`);
    return new Text(lines.join("\n"), 0, 0);
  }

  if (args.tasks?.length) {
    const lines = [
      `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", `parallel (${args.tasks.length})`)}`,
      ...args.tasks.slice(0, 5).map((task) => `  ${theme.fg("muted", "•")} ${theme.fg("accent", buildPantheonSpecialistPickerLabel(task.agent))} ${theme.fg("muted", previewText(task.task, 72))}`),
    ];
    if (args.tasks.length > 5) lines.push(`  ${theme.fg("muted", `… +${args.tasks.length - 5} more`)}`);
    return new Text(lines.join("\n"), 0, 0);
  }

  const rationale = buildPantheonDelegateRationale(args.agent);
  const lines = [
    `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", buildPantheonSpecialistPickerLabel(args.agent || "specialist"))}`,
    `  ${theme.fg("muted", previewText(args.task || "", 90))}`,
    ...(rationale ? [`  ${theme.fg("dim", "why:")} ${theme.fg("muted", rationale)}`] : []),
  ];
  return new Text(lines.join("\n"), 0, 0);
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
    `${theme.fg("toolTitle", theme.bold("pantheon_delegate"))} ${theme.fg("accent", `${details.mode ?? "single"}`)}`,
    summarizeResultStates(details.results, theme),
  ];

  const results = expanded ? details.results : details.results.slice(0, 6);
  for (const item of results) {
    lines.push(formatResultLine(item, theme, expanded ? 180 : 110));
    const rationale = buildPantheonDelegateRationale(item.agent);
    if (rationale) {
      lines.push(`  ${theme.fg("dim", "why:")} ${theme.fg("muted", rationale)}`);
    }
    if (expanded) {
      for (const detail of buildSubagentExpandedLines({ label: item.agent, result: item }, { stdoutLines: 3, stderrLines: 2 })) {
        lines.push(`  ${theme.fg("muted", detail)}`);
      }
    }
  }
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
  ];
  for (const councillor of details.councillors) {
    lines.push(formatResultLine({ ...councillor, agent: `member ${councillor.memberName}` }, theme, expanded ? 180 : 90));
    if (expanded) {
      for (const detail of buildSubagentExpandedLines({ label: `${councillor.memberName} · council member`, result: councillor }, { stdoutLines: 3, stderrLines: 2 })) {
        lines.push(`  ${theme.fg("muted", detail)}`);
      }
    }
  }
  lines.push(formatResultLine({ ...details.master, agent: "council synthesis" }, theme, expanded ? 220 : 110));
  if (expanded) {
    for (const detail of buildSubagentExpandedLines({ label: "master · council synthesis", result: details.master }, { stdoutLines: 3, stderrLines: 2 })) {
      lines.push(`  ${theme.fg("muted", detail)}`);
    }
  }
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

const CORE_CLI_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function canUseCliToolFilter(tools: string[] | undefined): boolean {
  return tools?.length ? tools.every((tool) => CORE_CLI_TOOL_NAMES.has(tool)) : false;
}

function buildSubagentSystemPrompt(systemPrompt: string, tools: string[] | undefined, noTools: boolean | undefined): string {
  const parts = [systemPrompt.trim()];
  if (!noTools && tools?.length && !canUseCliToolFilter(tools)) {
    parts.push([
      "Tool policy:",
      `- Your allowed tools for this task are: ${tools.join(", ")}.`,
      "- Do not use tools outside that allowlist, even if they appear in the runtime.",
      "- This allowlist is prompt-enforced because pi CLI --tools filtering only recognizes core built-in tools before extensions load.",
    ].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
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
  finalMessageGraceMs: number,
  onActivity?: () => void,
  debug?: SubagentDebugContext,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.options?.length) args.push(...agent.options);
  if (agent.noTools) args.push("--no-tools");
  else if (canUseCliToolFilter(agent.tools)) args.push("--tools", agent.tools!.join(","));
  const systemPrompt = buildSubagentSystemPrompt(agent.systemPrompt, agent.tools, agent.noTools);

  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
    debugTraceId: debug?.traceId,
    debugLabel: debug?.label,
    debugDir: debug?.dir,
    debugSummaryPath: debug?.summaryPath,
    debugStdoutPath: debug?.stdoutPath,
    debugStderrPath: debug?.stderrPath,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: summarizeResult(currentResult) || "(running...)" }],
      details: { results: [currentResult] },
    });
  };

  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }

  args.push(`Task: ${task}`);
  const invocation = getPiInvocation(args);
  const startedAt = Date.now();
  currentResult.startedAt = startedAt;
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
    let lingerTimer: NodeJS.Timeout | undefined;

    const clearLingerTimer = () => {
      if (!lingerTimer) return;
      clearTimeout(lingerTimer);
      lingerTimer = undefined;
    };

    const scheduleLingerShutdown = () => {
      if (lingerTimer) return;
      lingerTimer = setTimeout(() => {
        lingerTimer = undefined;
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
      }, finalMessageGraceMs);
    };

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
          if (isLikelyFinalAssistantMessage(msg)) scheduleLingerShutdown();
        }
        emitUpdate();
      }

      if (event.type === "tool_result_end" && event.message) {
        currentResult.messages.push(event.message as Message);
        emitUpdate();
      }
    };

    proc.stdout.on("data", (data) => {
      onActivity?.();
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      onActivity?.();
      const text = data.toString();
      currentResult.stderr += text;
      if (debug) writeDebugText(debug.stderrPath, text);
    });

    proc.on("close", (code) => {
      clearLingerTimer();
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", (error) => {
      clearLingerTimer();
      currentResult.errorMessage = error instanceof Error ? error.message : String(error);
      if (debug) writeDebugText(debug.stderrPath, `${currentResult.errorMessage}\n`);
      resolve(1);
    });

    if (signal) {
      const killProc = () => {
        clearLingerTimer();
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
  currentResult.finishedAt = Date.now();
  currentResult.durationMs = currentResult.finishedAt - startedAt;
  if (abortReason && !currentResult.stderr.includes(`Subagent aborted (${abortReason})`)) {
    currentResult.stderr = `${currentResult.stderr}${currentResult.stderr ? "\n" : ""}Subagent aborted (${abortReason})`;
  }
  if (debug) {
    writeDebugJson(debug.summaryPath, {
      label: debug.label,
      startedAt,
      finishedAt: currentResult.finishedAt,
      durationMs: currentResult.durationMs,
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
  const finalMessageGraceMs = resolveFinalMessageGraceMs(config);
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
    let timer: NodeJS.Timeout | undefined;
    const resetAttemptTimeout = () => {
      if (timeoutMs <= 0 || controller.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    };
    resetAttemptTimeout();

    const debug = createSubagentDebugContext(
      debugTrace,
      `${debugLabel ?? agentName}${step ? `-step-${step}` : ""}-attempt-${attemptIndex + 1}${model ? `-${model}` : ""}`,
      { agentName, model, step, cwd: cwd ?? ctxCwd, task, timeoutMs, finalMessageGraceMs },
    );

    try {
      appendDebugEvent(debugTrace, "attempt_start", { agentName, model, step, attempt: attemptIndex + 1, label: debug?.label, timeoutMs, finalMessageGraceMs });
      const result = await runSingleAgent(ctxCwd, attemptAgent, task, cwd, step, controller.signal, onUpdate, finalMessageGraceMs, resetAttemptTimeout, debug);
      lastResult = result;
      const emptyResponse = !hasMeaningfulResult(result);
      if (emptyResponse && retryOnEmpty && !result.errorMessage && !result.stderr.trim()) {
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

const WebfetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch with docs-aware extraction" }),
  preferLlmsTxt: Type.Optional(Type.String({ description: "llms.txt preference mode: auto, always, or never.", default: "auto" })),
  extractMain: Type.Optional(Type.Boolean({ description: "Extract main docs/article content for HTML pages. Default true.", default: true })),
  allowCrossOriginRedirects: Type.Optional(Type.Boolean({ description: "Allow redirects to a different origin. Default false.", default: false })),
  maxChars: Type.Optional(Type.Number({ description: "Maximum response characters to return.", default: 12000 })),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Web search query" }),
  scope: Type.Optional(Type.String({ description: "Optional search scope: web, github, or docs" })),
  site: Type.Optional(Type.String({ description: "Optional docs site/domain restriction, e.g. nextjs.org" })),
  repo: Type.Optional(Type.String({ description: "Optional GitHub repo owner/name for targeted repo research" })),
});

const AdapterSearchParams = Type.Object({
  adapter: Type.Optional(Type.String({ description: "Adapter id to use, e.g. docs-context7, npm-registry, grep-app, web-search, github-releases, or auto." })),
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

const AdapterHealthParams = Type.Object({
  adapter: Type.Optional(Type.String({ description: "Optional specific adapter id to inspect." })),
});

const BackgroundLogParams = Type.Object({
  taskId: Type.String({ description: "Background task id" }),
  lines: Type.Optional(Type.Number({ description: "Number of log lines to return", default: 80 })),
});

const AutoContinueParams = Type.Object({
  enabled: Type.Boolean({ description: "Enable or disable auto-continue" }),
});

const BootstrapParams = Type.Object({
  force: Type.Optional(Type.Boolean({ description: "Overwrite bootstrap files if they already exist.", default: false })),
});

const SpecTemplateParams = Type.Object({
  kind: Type.String({ description: "Template kind: feature, refactor, investigation, or incident." }),
  title: Type.String({ description: "Specification title." }),
  context: Type.Optional(Type.String({ description: "Optional context snapshot to seed the template." })),
  focusAreas: Type.Optional(Type.String({ description: "Optional focus areas or review lenses to emphasize." })),
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

const StatsParams = Type.Object({});

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

interface AdapterSummary {
  text: string;
  details?: unknown;
}

interface AdapterHealthResult {
  status: "ok" | "warn" | "error";
  summary: string;
  auth: "configured" | "missing" | "not-required";
  details?: unknown;
}

interface PantheonAdapter {
  id: string;
  label: string;
  description: string;
  auth?: {
    required?: boolean;
    env?: string[];
    summary?: string;
  };
  health?(cwd: string, config: PantheonConfig, signal?: AbortSignal): Promise<AdapterHealthResult>;
  search(params: AdapterInvocationParams, config: PantheonConfig, signal?: AbortSignal): Promise<AdapterSummary>;
  fetch(params: AdapterInvocationParams, config: PantheonConfig, signal?: AbortSignal): Promise<AdapterSummary>;
}

interface PantheonAdapterModuleContext {
  cwd: string;
  config: PantheonConfig;
  signal?: AbortSignal;
  helpers: {
    previewText(text: string, max?: number): string;
    fetchText(url: string, signal?: AbortSignal): Promise<string>;
    fetchJson<T>(url: string, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<T>;
    webSearch(query: string, options?: { scope?: string; site?: string; repo?: string; maxResults?: number }, signal?: AbortSignal): Promise<string>;
    webSearchResults(query: string, options?: { scope?: string; site?: string; repo?: string; maxResults?: number }, signal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet?: string }>>;
    resolveDocsSources(packageName?: string, version?: string, repo?: string, site?: string, signal?: AbortSignal): Promise<{ packageName?: string; repo?: string; homepage?: string; docsSite?: string; candidates: Array<{ label: string; url: string }> }>;
    fetchDocsEntry(params: AdapterInvocationParams, signal?: AbortSignal): Promise<string>;
    fetchGithubFile(repo: string, filePath: string, ref?: string, signal?: AbortSignal): Promise<string>;
    fetchGithubReleases(repo: string, limit?: number, signal?: AbortSignal): Promise<string>;
    fetchNpmInfo(pkg: string, version?: string, signal?: AbortSignal): Promise<string>;
    fetchPackageDocs(pkg: string, version?: string, maxChars?: number, signal?: AbortSignal): Promise<string>;
    htmlToText(text: string): string;
  };
}

interface PantheonAdapterModuleShape {
  id: string;
  label?: string;
  description?: string;
  auth?: PantheonAdapter["auth"];
  health?: (ctx: PantheonAdapterModuleContext) => Promise<AdapterHealthResult | string> | AdapterHealthResult | string;
  search?: (params: AdapterInvocationParams, ctx: PantheonAdapterModuleContext) => Promise<AdapterSummary | string> | AdapterSummary | string;
  fetch?: (params: AdapterInvocationParams, ctx: PantheonAdapterModuleContext) => Promise<AdapterSummary | string> | AdapterSummary | string;
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

function resolveGithubToken(config: PantheonConfig): string | undefined {
  return config.research?.githubToken?.trim() || process.env.PANTHEON_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || undefined;
}

function detectAdapterAuth(adapter: PantheonAdapter, config: PantheonConfig): AdapterHealthResult["auth"] {
  if (!adapter.auth?.required) return "not-required";
  const envs = adapter.auth.env ?? [];
  return envs.some((name) => process.env[name]?.trim()) || (adapter.id.startsWith("github") && Boolean(resolveGithubToken(config))) ? "configured" : "missing";
}

async function healthCheckAdapter(cwd: string, config: PantheonConfig, adapter: PantheonAdapter, signal?: AbortSignal): Promise<AdapterHealthResult> {
  if (typeof adapter.health === "function") {
    const result = await adapter.health(cwd, config, signal);
    return { ...result, auth: result.auth ?? detectAdapterAuth(adapter, config) };
  }
  const auth = detectAdapterAuth(adapter, config);
  return {
    status: auth === "missing" ? "warn" : "ok",
    summary: auth === "missing"
      ? `${adapter.id} is available but missing optional auth (${(adapter.auth?.env ?? []).join(", ") || "configure adapter auth"}).`
      : `${adapter.id} is registered and ready.`,
    auth,
  };
}

function buildAdapterHealthLines(results: Array<{ adapter: PantheonAdapter; health: AdapterHealthResult }>): string {
  return results.map(({ adapter, health }) => `- ${adapter.id} [${health.status}] auth=${health.auth} — ${health.summary}`).join("\n") || "(no adapters)";
}

function buildAdapterModuleContext(cwd: string, config: PantheonConfig, signal?: AbortSignal): PantheonAdapterModuleContext {
  const timeoutMs = config.research?.timeoutMs ?? 15000;
  const userAgent = config.research?.userAgent ?? PANTHEON_USER_AGENT;
  const defaultDocsSite = config.research?.defaultDocsSite;
  const githubToken = resolveGithubToken(config);
  return {
    cwd,
    config,
    signal,
    helpers: {
      previewText,
      fetchText: (url, nestedSignal) => fetchText(url, timeoutMs, userAgent, nestedSignal ?? signal),
      fetchJson: <T>(url: string, nestedSignal?: AbortSignal, extraHeaders?: Record<string, string>) => fetchJson<T>(url, timeoutMs, userAgent, nestedSignal ?? signal, extraHeaders),
      webSearch: (query, options, nestedSignal) => webSearch(query, timeoutMs, userAgent, Math.max(1, Math.min(10, Math.floor(options?.maxResults ?? config.research?.maxResults ?? 5))), nestedSignal ?? signal, options?.scope, options?.site, options?.repo, defaultDocsSite),
      webSearchResults: (query, options, nestedSignal) => webSearchResults(query, timeoutMs, userAgent, Math.max(1, Math.min(10, Math.floor(options?.maxResults ?? config.research?.maxResults ?? 5))), nestedSignal ?? signal, options?.scope, options?.site, options?.repo, defaultDocsSite),
      resolveDocsSources: (packageName, version, repo, site, nestedSignal) => resolveDocsSources(packageName, version, repo, site, timeoutMs, userAgent, nestedSignal ?? signal),
      fetchDocsEntry: (params, nestedSignal) => fetchDocsEntry(params, timeoutMs, userAgent, nestedSignal ?? signal, params.maxChars ?? 12000),
      fetchGithubFile: (repo, filePath, ref, nestedSignal) => fetchGithubFile(repo, filePath, ref, timeoutMs, userAgent, nestedSignal ?? signal, githubToken),
      fetchGithubReleases: (repo, limit, nestedSignal) => fetchGithubReleases(repo, limit ?? 5, timeoutMs, userAgent, nestedSignal ?? signal, githubToken),
      fetchNpmInfo: (pkg, version, nestedSignal) => fetchNpmInfo(pkg, version, timeoutMs, userAgent, nestedSignal ?? signal),
      fetchPackageDocs: (pkg, version, maxChars, nestedSignal) => fetchPackageDocs(pkg, version, timeoutMs, userAgent, nestedSignal ?? signal, maxChars ?? 12000, githubToken),
      htmlToText,
    },
  };
}

function coerceAdapterSummary(result: AdapterSummary | string): AdapterSummary {
  if (typeof result === "string") return { text: result };
  return result;
}

function coerceAdapterHealth(result: AdapterHealthResult | string): AdapterHealthResult {
  if (typeof result === "string") return { status: "ok", summary: result, auth: "not-required" };
  return result;
}

function coerceCustomAdapter(modulePath: string, candidate: unknown, cwd: string, config: PantheonConfig): PantheonAdapter {
  if (!candidate || typeof candidate !== "object") throw new Error(`Adapter module ${modulePath} did not export an object.`);
  const shape = candidate as PantheonAdapterModuleShape;
  if (typeof shape.id !== "string" || !shape.id.trim()) throw new Error(`Adapter module ${modulePath} is missing a valid id.`);
  if (typeof shape.search !== "function" && typeof shape.fetch !== "function") {
    throw new Error(`Adapter module ${modulePath} must implement search and/or fetch.`);
  }
  return {
    id: shape.id.trim(),
    label: typeof shape.label === "string" && shape.label.trim() ? shape.label.trim() : shape.id.trim(),
    description: typeof shape.description === "string" && shape.description.trim() ? shape.description.trim() : `Custom adapter loaded from ${modulePath}`,
    auth: shape.auth,
    async health(_adapterCwd, adapterConfig, signal) {
      if (typeof shape.health === "function") {
        return coerceAdapterHealth(await shape.health(buildAdapterModuleContext(cwd, adapterConfig, signal)));
      }
      return {
        status: "ok",
        summary: `Custom adapter '${shape.id}' loaded successfully from ${modulePath}`,
        auth: shape.auth?.required ? "missing" : "not-required",
      };
    },
    async search(params, adapterConfig, signal) {
      if (typeof shape.search !== "function") throw new Error(`Adapter '${shape.id}' does not support search.`);
      return coerceAdapterSummary(await shape.search(params, buildAdapterModuleContext(cwd, adapterConfig, signal)));
    },
    async fetch(params, adapterConfig, signal) {
      if (typeof shape.fetch !== "function") throw new Error(`Adapter '${shape.id}' does not support fetch.`);
      return coerceAdapterSummary(await shape.fetch(params, buildAdapterModuleContext(cwd, adapterConfig, signal)));
    },
  };
}

function collectConfiguredAdapterModulePaths(cwd: string, config: PantheonConfig): string[] {
  const discoveredDirs = [
    path.join(getAgentDir(), "pantheon-adapters"),
    findNearestProjectPath(cwd, path.join(".pi", "pantheon-adapters")) ?? undefined,
  ].filter((value): value is string => Boolean(value));

  const discoveredFiles = discoveredDirs.flatMap((dir) => {
    try {
      return fs.readdirSync(dir)
        .filter((entry) => /\.(mjs|js|cjs)$/i.test(entry))
        .map((entry) => path.join(dir, entry));
    } catch {
      return [];
    }
  });

  return [...new Set([...(config.adapters?.modules ?? []), ...discoveredFiles])];
}

async function loadConfiguredAdapterModules(cwd: string, config: PantheonConfig): Promise<{ adapters: PantheonAdapter[]; errors: string[] }> {
  const modulePaths = collectConfiguredAdapterModulePaths(cwd, config);
  const adapters: PantheonAdapter[] = [];
  const errors: string[] = [];
  for (const modulePath of modulePaths) {
    try {
      if (!fs.existsSync(modulePath)) throw new Error("file not found");
      const stat = fs.statSync(modulePath);
      const imported = await import(`${pathToFileURL(modulePath).href}?mtime=${Math.floor(stat.mtimeMs)}`);
      const candidate = imported.default ?? imported.adapter ?? imported;
      adapters.push(coerceCustomAdapter(modulePath, candidate, cwd, config));
    } catch (error) {
      errors.push(`Adapter module load failed (${modulePath}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { adapters, errors };
}

function searchLocalDocs(cwd: string, query: string, limit: number): AdapterSummary {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const roots = [cwd, path.join(cwd, "docs")];
  const seen = new Set<string>();
  const candidates: Array<{ path: string; score: number; excerpt: string }> = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !/\.(md|mdx|txt)$/i.test(entry.name)) continue;
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        const text = fs.readFileSync(fullPath, "utf8");
        const lower = text.toLowerCase();
        let score = 0;
        for (const term of terms) if (lower.includes(term)) score += 1;
        if (score === 0) continue;
        const firstMatch = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
        const excerpt = previewText(text.slice(Math.max(0, firstMatch - 120), firstMatch + 320), 260);
        candidates.push({ path: path.relative(cwd, fullPath), score, excerpt });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const top = candidates.slice(0, Math.max(1, Math.min(20, Math.floor(limit))));
  if (top.length === 0) return { text: `Adapter: local-docs\nQuery: ${query}\n\nNo local documentation matches found.` };
  return {
    text: `Adapter: local-docs\nQuery: ${query}\n\n${top.map((item, index) => `${index + 1}. ${item.path} (score ${item.score})\n   ${item.excerpt}`).join("\n\n")}`,
    details: { results: top },
  };
}

async function searchGithubCode(
  repo: string,
  query: string,
  timeoutMs: number,
  userAgent: string,
  signal?: AbortSignal,
  githubToken?: string,
  limit = 5,
): Promise<AdapterSummary> {
  const scoped = `${query} repo:${repo}`;
  const payload = await fetchJson<any>(`https://api.github.com/search/code?q=${encodeURIComponent(scoped)}&per_page=${Math.max(1, Math.min(10, Math.floor(limit)))}`,
    timeoutMs,
    userAgent,
    signal,
    githubToken?.trim()
      ? { authorization: `Bearer ${githubToken.trim()}`, accept: "application/vnd.github.text-match+json" }
      : { accept: "application/vnd.github.text-match+json" },
  );
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) return { text: `Adapter: github-code-search\nRepo: ${repo}\nQuery: ${query}\n\nNo code search results found.` };
  return {
    text: `Adapter: github-code-search\nRepo: ${repo}\nQuery: ${query}\n\n${items.map((item: any, index: number) => {
      const fragment = Array.isArray(item.text_matches) && item.text_matches.length > 0
        ? previewText(item.text_matches.map((match: any) => match.fragment).join(" … "), 240)
        : "(no excerpt)";
      return `${index + 1}. ${item.path}\n   ${item.html_url}\n   ${fragment}`;
    }).join("\n\n")}`,
    details: { items },
  };
}

function getBuiltInAdapters(cwd: string, config: PantheonConfig): PantheonAdapter[] {
  const timeoutMs = config.research?.timeoutMs ?? 15000;
  const userAgent = config.research?.userAgent ?? PANTHEON_USER_AGENT;
  const defaultDocsSite = config.research?.defaultDocsSite;
  const githubToken = resolveGithubToken(config);

  return [
    {
      id: "docs-context7",
      label: "Docs Context",
      description: "Package/repo/site-aware docs resolution and fetch, similar to a Context7-style docs source.",
      async health() {
        return { status: "ok", summary: "Docs resolution is available without extra authentication.", auth: "not-required" };
      },
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
      id: "local-docs",
      label: "Local Docs",
      description: "Search README/docs markdown files inside the current repository before going to external sources.",
      async health() {
        const result = searchLocalDocs(cwd, "readme docs guide", 1);
        return {
          status: /No local docs matches found/i.test(result.text) ? "warn" : "ok",
          summary: /No local docs matches found/i.test(result.text) ? "No README/docs hits were detected in the current repo yet." : "Repository-local docs are available for fast lookup.",
          auth: "not-required",
        };
      },
      async search(params) {
        return searchLocalDocs(cwd, params.query?.trim() || params.topic?.trim() || "", params.limit ?? 5);
      },
      async fetch(params) {
        const result = searchLocalDocs(cwd, params.query?.trim() || params.topic?.trim() || "", 1);
        return { text: result.text };
      },
    },
    {
      id: "grep-app",
      label: "grep.app",
      description: "Public code search over indexed repositories, similar to grep.app.",
      async health() {
        return { status: "ok", summary: "Public code-search fallback is available.", auth: "not-required" };
      },
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
      auth: { required: false, env: ["PANTHEON_GITHUB_TOKEN", "GITHUB_TOKEN"], summary: "GitHub token improves rate limits and private-access compatibility." },
      async health(_adapterCwd, adapterConfig) {
        const configured = Boolean(resolveGithubToken(adapterConfig));
        return {
          status: configured ? "ok" : "warn",
          summary: configured ? "GitHub token detected for release lookup." : "GitHub token not configured; release lookup may be rate-limited.",
          auth: configured ? "configured" : "missing",
        };
      },
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
      id: "github-code-search",
      label: "GitHub Code Search",
      description: "Structured GitHub code search within a repository.",
      auth: { required: false, env: ["PANTHEON_GITHUB_TOKEN", "GITHUB_TOKEN"], summary: "GitHub token improves rate limits and search reliability." },
      async health(_adapterCwd, adapterConfig) {
        const configured = Boolean(resolveGithubToken(adapterConfig));
        return {
          status: configured ? "ok" : "warn",
          summary: configured ? "GitHub token detected for code search." : "GitHub token not configured; code search may be rate-limited.",
          auth: configured ? "configured" : "missing",
        };
      },
      async search(params, _config, signal) {
        if (!params.repo?.trim()) throw new Error("github-code-search requires `repo`.");
        return searchGithubCode(params.repo.trim(), params.query?.trim() || params.topic?.trim() || "", timeoutMs, userAgent, signal, githubToken, params.limit ?? 5);
      },
      async fetch(params, _config, signal) {
        if (!params.repo?.trim() || !params.path?.trim()) throw new Error("github-code-search fetch requires both `repo` and `path`.");
        return { text: await fetchGithubFile(params.repo.trim(), params.path.trim(), undefined, timeoutMs, userAgent, signal, githubToken) };
      },
    },
    {
      id: "npm-registry",
      label: "npm Registry",
      description: "Structured npm package metadata and README retrieval for package-aware research.",
      async health() {
        return { status: "ok", summary: "npm metadata and README lookup is available.", auth: "not-required" };
      },
      async search(params, _config, signal) {
        const pkg = params.package?.trim() || params.query?.trim();
        if (!pkg) throw new Error("npm-registry search requires `package` or a package-like `query`.");
        const info = await fetchNpmInfo(pkg, params.version, timeoutMs, userAgent, signal);
        const docs = await fetchPackageDocs(pkg, params.version, timeoutMs, userAgent, signal, Math.min(params.maxChars ?? 3200, 3200), githubToken);
        return { text: `Adapter: npm-registry\nPackage: ${pkg}\n\n${info}\n\nREADME excerpt:\n${previewText(docs, 3200)}` };
      },
      async fetch(params, _config, signal) {
        const pkg = params.package?.trim() || params.query?.trim();
        if (!pkg) throw new Error("npm-registry fetch requires `package` or a package-like `query`.");
        return { text: await fetchPackageDocs(pkg, params.version, timeoutMs, userAgent, signal, params.maxChars ?? 12000, githubToken) };
      },
    },
    {
      id: "web-search",
      label: "Web Search",
      description: "Generic web/docs/github search fallback.",
      async health() {
        return { status: "ok", summary: "Generic web-search fallback is available.", auth: "not-required" };
      },
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

async function getEffectiveAdapters(cwd: string, config: PantheonConfig): Promise<{ adapters: PantheonAdapter[]; loadErrors: string[] }> {
  const builtIns = getBuiltInAdapters(cwd, config);
  const custom = await loadConfiguredAdapterModules(cwd, config);
  const registry = new Map<string, PantheonAdapter>();
  for (const adapter of builtIns) registry.set(adapter.id, adapter);
  for (const adapter of custom.adapters) registry.set(adapter.id, adapter);
  return { adapters: [...registry.values()], loadErrors: custom.errors };
}

async function getAllowedAdapters(cwd: string, config: PantheonConfig): Promise<{ agentName?: string; adapters: PantheonAdapter[]; registered: PantheonAdapter[]; loadErrors: string[] }> {
  const loaded = await getEffectiveAdapters(cwd, config);
  const agentName = getCurrentPantheonAgent();
  const policy = resolveAgentAdapterPolicy(config, agentName ?? "interactive");
  if (policy.disableAll) return { agentName, adapters: [], registered: loaded.adapters, loadErrors: loaded.loadErrors };

  const allowAll = policy.allow.includes("*");
  const denyAll = policy.deny.includes("*") || policy.allow.includes("!*") || policy.deny.includes("!*");
  const explicitAllow = new Set(policy.allow.filter((item) => item !== "*" && item !== "!*"));
  const explicitDeny = new Set(policy.deny.filter((item) => item !== "*" && item !== "!*").map((item) => item.startsWith("!") ? item.slice(1) : item));
  const disabled = new Set(policy.disabled.filter(Boolean));

  const adapters = loaded.adapters.filter((adapter) => {
    if (disabled.has(adapter.id)) return false;
    if (denyAll) return explicitAllow.has(adapter.id);
    if (explicitDeny.has(adapter.id)) return false;
    if (allowAll) return true;
    if (explicitAllow.size > 0 && !explicitAllow.has(adapter.id)) return false;
    return true;
  });
  return { agentName, adapters, registered: loaded.adapters, loadErrors: loaded.loadErrors };
}

async function requireAdapter(cwd: string, config: PantheonConfig, adapterId: string): Promise<PantheonAdapter> {
  const { agentName, adapters, registered } = await getAllowedAdapters(cwd, config);
  const adapter = adapters.find((item) => item.id === adapterId);
  if (!adapter) {
    const current = registered.map((item) => item.id).join(", ");
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
            content: [{ type: "text", text: `Council members (${resolvedPresetName}): ${completed}/${members.length} responded...` }],
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

function rememberBackgroundTaskId(ctxCwd: string, config: PantheonConfig, taskId: string): void {
  if (config.workflow?.persistTodos === false) return;
  updateWorkflowState(ctxCwd, config, (state) => ({
    ...state,
    recentBackgroundTaskIds: [...(state.recentBackgroundTaskIds ?? []), taskId],
  }));
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(PANTHEON_COMMAND_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as { command?: string; body?: string; status?: "success" | "warning" | "error" | "running"; summary?: string } | undefined;
    if (!details?.command || !details?.body) return new Text(typeof message.content === "string" ? message.content : String(message.content ?? ""), 0, 0);
    return renderPantheonCommandMessage({
      command: details.command,
      body: details.body,
      status: details.status ?? "success",
      summary: details.summary,
    }, expanded, theme as RenderTheme & { bg: (color: string, text: string) => string });
  });

  const presentPantheonCommandEditorOutput = (
    command: string,
    text: string,
    ctx: ExtensionContext,
    options?: Parameters<typeof presentPantheonCommandEditorOutputBase>[3],
  ) => presentPantheonCommandEditorOutputBase(command, text, ctx, {
    ...options,
    dispatchMessage: (message) => pi.sendMessage(message),
  });

  const presentPantheonCommandProgress = (
    command: string,
    result: AgentToolResult<any> & { isError?: boolean },
    ctx: ExtensionContext,
    summary: string,
    options?: Parameters<typeof presentPantheonCommandProgressBase>[4],
  ) => presentPantheonCommandProgressBase(command, result, ctx, summary, {
    ...options,
    dispatchMessage: (message) => pi.sendMessage(message),
  });

  const presentPantheonCommandResult = (
    command: string,
    result: AgentToolResult<any> & { isError?: boolean },
    ctx: ExtensionContext,
    successMessage: string,
    failureMessage: string,
    options?: Parameters<typeof presentPantheonCommandResultBase>[5],
  ) => presentPantheonCommandResultBase(command, result, ctx, successMessage, failureMessage, {
    ...options,
    dispatchMessage: (message) => pi.sendMessage(message),
  });

  const orchestratorPrompt = loadOrchestratorPrompt();
  const notifiedTasks = new Set<string>();
  const toolExecutionStarts = new Map<string, { toolName: string; startedAt: number }>();
  let poller: ReturnType<typeof setInterval> | undefined;
  let autoContinueEnabled = false;
  let autoContinueCount = 0;
  let autoContinueTimer: ReturnType<typeof setTimeout> | undefined;
  let latestConfig: PantheonConfig | undefined;
  let latestWarningCount = 0;
  let turnFileMutationCount = 0;
  let lastGuidanceAt = 0;
  let executePantheonDelegateCommand:
    | ((params: { agent?: string; task?: string; tasks?: Array<{ agent: string; task: string; cwd?: string }>; chain?: Array<{ agent: string; task: string; cwd?: string }>; includeProjectAgents?: boolean; cwd?: string }, signal: AbortSignal | undefined, onUpdate: ((partial: AgentToolResult<any>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<any>>)
    | undefined;
  let executePantheonCouncilCommand:
    | ((params: { prompt: string; preset?: string; includeProjectAgents?: boolean }, signal: AbortSignal | undefined, onUpdate: ((partial: AgentToolResult<any>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<any>>)
    | undefined;
  const orchestration = new PantheonOrchestrationRuntime();
  const commandsAllowedWhenDisabled = new Set(["pantheon-config", "pantheon-bootstrap"]);
  const toolsAllowedWhenDisabled = new Set(["pantheon_bootstrap"]);

  const isPantheonEnabled = (config: PantheonConfig | undefined) => config?.enabled !== false;

  const clearPantheonUi = (ctx: ExtensionContext) => {
    ctx.ui.setWidget("oh-my-opencode-pi-dashboard", undefined);
    clearSubagentActivityWidget(ctx, true);
    ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
    ctx.ui.setStatus(WORKFLOW_GUIDANCE_KEY, undefined);
    ctx.ui.setStatus(AUTO_CONTINUE_KEY, "Auto-continue: off");
  };

  const formatPantheonDisabledMessage = (configResult: ReturnType<typeof loadPantheonConfig>, subject = "oh-my-opencode-pi") => {
    const source = configResult.sources.projectPath ?? configResult.sources.globalPath;
    return `${subject} is disabled in config (${source}). Set "enabled": true and start a new session to re-enable it.`;
  };

  const baseRegisterCommand = pi.registerCommand.bind(pi);
  (pi as { registerCommand: typeof pi.registerCommand }).registerCommand = ((name: string, spec: { handler?: (args: string, ctx: ExtensionContext) => unknown }) => {
    if (typeof spec?.handler !== "function") return baseRegisterCommand(name, spec as never);
    return baseRegisterCommand(name, {
      ...spec,
      handler: async (args: string, ctx: ExtensionContext) => {
        const configResult = loadPantheonConfig(ctx.cwd);
        latestConfig = configResult.config;
        latestWarningCount = configResult.warnings.length;
        if (!commandsAllowedWhenDisabled.has(name) && !isPantheonEnabled(configResult.config)) {
          clearPantheonUi(ctx);
          ctx.ui.setStatus(CONFIG_WARNING_KEY, "oh-my-opencode-pi disabled");
          ctx.ui.notify(formatPantheonDisabledMessage(configResult, `/${name}`), "warning");
          return;
        }
        return spec.handler?.(args, ctx);
      },
    } as never);
  }) as typeof pi.registerCommand;

  const baseRegisterTool = pi.registerTool.bind(pi);
  (pi as { registerTool: typeof pi.registerTool }).registerTool = ((tool: { name: string; execute?: (...args: any[]) => unknown }) => {
    if (typeof tool?.execute !== "function") return baseRegisterTool(tool as never);
    return baseRegisterTool({
      ...tool,
      execute: async (...args: any[]) => {
        const ctx = args[4] as ExtensionContext | undefined;
        if (ctx?.cwd) {
          const configResult = loadPantheonConfig(ctx.cwd);
          latestConfig = configResult.config;
          latestWarningCount = configResult.warnings.length;
          if (!toolsAllowedWhenDisabled.has(tool.name) && !isPantheonEnabled(configResult.config)) {
            return {
              content: [{ type: "text", text: formatPantheonDisabledMessage(configResult, tool.name) }],
              details: { enabled: false },
              isError: true,
            };
          }
        }
        return tool.execute?.(...args);
      },
    } as never);
  }) as typeof pi.registerTool;

  const updatePantheonDashboard = (ctx: ExtensionContext, config = latestConfig ?? loadPantheonConfig(ctx.cwd).config) => {
    latestConfig = config;
    if (!isPantheonEnabled(config) || process.env[SUBAGENT_ENV] === "1" || config.ui?.dashboardWidget === false) {
      ctx.ui.setWidget("oh-my-opencode-pi-dashboard", undefined);
      return;
    }
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer, config.background?.staleAfterMs ?? 20000);
    const tasks = config.background?.enabled === false ? [] : maybeStartQueuedTasks(ctx.cwd, taskDir);
    const state = config.workflow?.persistTodos === false ? { updatedAt: 0, uncheckedTodos: [] } : readWorkflowState(ctx.cwd, config);
    const lines = buildPantheonDashboardLines(ctx, config, state, tasks, autoContinueEnabled, latestWarningCount);
    ctx.ui.setWidget("oh-my-opencode-pi-dashboard", lines.length > 0 ? lines : undefined, { placement: "belowEditor" });
  };

  const recordOrchestration = (hook: "session_start" | "session_shutdown" | "before_agent_start" | "context" | "before_provider_request" | "tool_call" | "tool_result" | "agent_end", summary: string, detail: Record<string, unknown>, ctx: ExtensionContext) => {
    orchestration.record(hook, summary, detail, ctx.cwd);
    ctx.ui.setStatus("oh-my-opencode-pi-hooks", `Hooks: ${orchestration.getSnapshot().sequence} events`);
  };

  pi.on("session_start", async (event, ctx) => {
    orchestration.restore(restorePantheonOrchestrationFromEntries(ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>));
    clearSubagentActivityWidget(ctx, true);
    const configResult = loadPantheonConfig(ctx.cwd);
    latestConfig = configResult.config;
    latestWarningCount = configResult.warnings.length;
    autoContinueEnabled = isPantheonEnabled(configResult.config) ? (configResult.config.autoContinue?.enabled ?? false) : false;
    autoContinueCount = 0;
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    ctx.ui.setStatus(AUTO_CONTINUE_KEY, autoContinueEnabled ? "Auto-continue: on" : "Auto-continue: off");
    clearSubagentActivityWidget(ctx);
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
      ctx.ui.setStatus(CONFIG_WARNING_KEY, isPantheonEnabled(configResult.config) ? "oh-my-opencode-pi ready" : "oh-my-opencode-pi disabled");
    }

    if (!isPantheonEnabled(configResult.config)) {
      ctx.ui.setStatus(VERSION_STATUS_KEY, undefined);
      clearPantheonUi(ctx);
      recordOrchestration("session_start", `Session ${event.reason} (disabled)`, { reason: event.reason, previousSessionFile: event.previousSessionFile, enabled: false }, ctx);
      return;
    }

    ctx.ui.setStatus(VERSION_STATUS_KEY, undefined);
    if (process.env[SUBAGENT_ENV] !== "1" && configResult.config.updates?.enabled !== false) {
      void checkForPackageUpdates(configResult.config).then((report) => {
        if (configResult.config.updates?.notify === false) return;
        if (report.status === "update-available" && report.latestVersion) {
          ctx.ui.setStatus(VERSION_STATUS_KEY, `Update available: ${report.currentVersion} → ${report.latestVersion}`);
        }
      }).catch(() => {
        // ignore background update-check failures during session startup
      });
    }

    if (poller) clearInterval(poller);
    if (configResult.config.background?.enabled !== false) {
      const taskDir = ensureDir(configResult.config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const refreshTasks = () => {
        reconcileBackgroundTasks(taskDir, configResult.config.multiplexer, configResult.config.background?.staleAfterMs ?? 20000);
        const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir);
        ctx.ui.setStatus(TASK_STATUS_KEY, summarizeBackgroundCounts(tasks, configResult.config.background?.staleAfterMs ?? 20000));
        updatePantheonDashboard(ctx, configResult.config);
        for (const task of tasks) {
          if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
            if (notifiedTasks.has(task.id)) continue;
            notifiedTasks.add(task.id);
            recordBackgroundStatus(ctx.cwd, configResult.config, task.status === "completed" ? "completed" : task.status === "cancelled" ? "cancelled" : "failed", `${task.agent}:${task.id}`);
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
    recordOrchestration("session_start", `Session ${event.reason}`, { reason: event.reason, previousSessionFile: event.previousSessionFile }, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    recordOrchestration("session_shutdown", "Session shutdown", {}, ctx);
    clearSubagentActivityWidget(ctx, true);
    pi.appendEntry("pantheon-orchestration", orchestration.getSnapshot());
    if (poller) clearInterval(poller);
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
  });

  pi.on("input", async (event, ctx) => {
    if (!isPantheonEnabled(loadPantheonConfig(ctx.cwd).config)) return { action: "continue" };
    if (event.source === "interactive" || event.source === "rpc") {
      autoContinueCount = 0;
      updatePantheonDashboard(ctx);
    }
    return { action: "continue" };
  });

  pi.on("context", async (event, ctx) => {
    if (!isPantheonEnabled(loadPantheonConfig(ctx.cwd).config)) return;
    recordOrchestration("context", `Prepared ${event.messages.length} context messages`, { messages: event.messages.length }, ctx);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!isPantheonEnabled(loadPantheonConfig(ctx.cwd).config)) return undefined;
    const payload = event.payload as Record<string, unknown> | undefined;
    const provider = typeof payload?.model === "string"
      ? String(payload.model).split("/")[0]
      : typeof payload?.provider === "string"
        ? String(payload.provider)
        : ctx.model?.provider ?? "unknown";
    recordOrchestration("before_provider_request", `Serialized provider payload for ${provider}`, { provider, keys: payload ? Object.keys(payload).slice(0, 8) : [] }, ctx);
    return undefined;
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!isPantheonEnabled(loadPantheonConfig(ctx.cwd).config)) {
      clearPantheonUi(ctx);
      return;
    }
    turnFileMutationCount = 0;
    clearSubagentActivityWidget(ctx, true);
    ctx.ui.setStatus(WORKFLOW_GUIDANCE_KEY, "Pantheon phases: scout → plan → implement → verify");
  });

  pi.on("tool_execution_start", async (event) => {
    toolExecutionStarts.set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const started = toolExecutionStarts.get(event.toolCallId);
    toolExecutionStarts.delete(event.toolCallId);
    const config = loadPantheonConfig(ctx.cwd).config;
    if (!isPantheonEnabled(config)) return;
    const durationMs = started ? Date.now() - started.startedAt : 0;
    const failureKind = classifyFailureKind(event.toolName, event.isError);
    if (event.toolName.startsWith("pantheon_")) {
      recordToolRun(ctx.cwd, config, event.toolName, event.isError ? "failed" : "success", durationMs, failureKind);
    }

    if (event.toolName === "pantheon_delegate") {
      const details = event.result?.details as DelegateDetails | undefined;
      const agentName = details?.results?.[0]?.agent;
      recordCategoryRun(ctx.cwd, config, "delegate", event.isError ? "failed" : "success", durationMs, details?.mode ?? "delegate", agentName);
    }
    if (event.toolName === "pantheon_council") {
      recordCategoryRun(ctx.cwd, config, "council", event.isError ? "failed" : "success", durationMs, "council");
    }
    if (event.toolName === "pantheon_background" && !event.isError) {
      const record = event.result?.details as BackgroundTaskRecord | undefined;
      if (record) recordBackgroundStatus(ctx.cwd, config, "queued", `${record.agent}:${record.id}`);
    }
    if (event.toolName === "pantheon_adapter_search") {
      const adapters = (event.result?.details?.adapters ?? []) as Array<{ adapter: string; error?: string }>;
      for (const adapter of adapters) recordAdapterUsage(ctx.cwd, config, adapter.adapter, "search", Boolean(adapter.error));
      recordCategoryRun(ctx.cwd, config, "adapter_search", event.isError ? "failed" : "success", durationMs, "adapter-search");
    }
    if (event.toolName === "pantheon_adapter_fetch") {
      const adapterId = event.result?.details?.adapter as string | undefined;
      if (adapterId) recordAdapterUsage(ctx.cwd, config, adapterId, "fetch", event.isError);
      recordCategoryRun(ctx.cwd, config, "adapter_fetch", event.isError ? "failed" : "success", durationMs, adapterId ?? "adapter-fetch");
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const config = loadPantheonConfig(ctx.cwd).config;
    if (!isPantheonEnabled(config)) return;
    recordOrchestration("tool_result", `${event.toolName}${event.isError ? " failed" : " ok"}`, { toolName: event.toolName, isError: event.isError }, ctx);
    if (process.env[SUBAGENT_ENV] === "1") return;
    const now = Date.now();

    if ((config.workflow?.postFileToolNudges ?? true) && !event.isError && ["edit", "write", "pantheon_ast_grep_replace", "pantheon_lsp_rename", "pantheon_apply_patch"].includes(event.toolName)) {
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
    if (!isPantheonEnabled(config)) return;
    recordOrchestration("agent_end", `Agent finished with ${event.messages.length} messages`, { messages: event.messages.length }, ctx);
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
    if (!isPantheonEnabled(config)) return;
    recordOrchestration("before_agent_start", previewText(event.prompt, 90), { prompt: previewText(event.prompt, 240), images: event.images?.length ?? 0 }, ctx);
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
    if (!isPantheonEnabled(loadPantheonConfig(ctx.cwd).config)) return;
    recordOrchestration("tool_call", `${event.toolName}`, { toolName: event.toolName }, ctx);
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

  async function handlePantheonSpecialistHelp(ctx: ExtensionContext) {
    const { agents } = discoverPantheonAgents(ctx.cwd, true);
    const report = buildPantheonQuickHelpReport(agents);
    await showPantheonReportModal(ctx, "Which specialist should I use?", "Pantheon specialist quick help", report);
  }

  async function handlePantheonAgentsCommand(_args: string, ctx: ExtensionContext) {
    const { agents, projectAgentsDir } = discoverPantheonAgents(ctx.cwd, true);
    const publicAgentCount = agents.filter((agent) => !["councillor", "council-master"].includes(agent.name)).length;
    const summary = `Specialist guide for ${publicAgentCount} public agent${publicAgentCount === 1 ? "" : "s"}`;
    const report = buildPantheonAgentsReport(agents, projectAgentsDir);
    presentPantheonCommandEditorOutput("/pantheon-agents", report, ctx, {
      summary,
      notifyMessage: "Opened Pantheon specialist guide.",
      status: "success",
      modes: ["widget-summary", "notify"],
    });
    await showPantheonReportModal(ctx, "Specialist guide", summary, report);
  }

  async function handlePantheonSkillsCommand(_args: string, ctx: ExtensionContext) {
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
      "Workflow:",
      "- Ask the orchestrator to run cartography for repository mapping work.",
      "- Use /skill:cartography directly when skill commands are enabled.",
      "- The cartography skill uses pantheon_repo_map and pantheon_code_map as low-level building blocks rather than dedicated slash commands.",
      "",
      "Starter config snippet:",
      snippet,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function handlePantheonAdapterHealthCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const { adapters } = await getAllowedAdapters(ctx.cwd, config);
    const results = await Promise.all(adapters.map(async (adapter) => ({ adapter, health: await healthCheckAdapter(ctx.cwd, config, adapter) })));
    const text = buildAdapterHealthLines(results);
    const level = results.some(({ health }) => health.status === "error")
      ? "error"
      : results.some(({ health }) => health.status === "warn")
        ? "warning"
        : "info";
    ctx.ui.notify(text, level);
  }

  async function handlePantheonDoctorCommand(_args: string, ctx: ExtensionContext) {
    const configResult = loadPantheonConfig(ctx.cwd);
    const config = configResult.config;
    const { adapters } = await getAllowedAdapters(ctx.cwd, config);
    const adapterHealth = await Promise.all(adapters.map(async (adapter) => ({
      id: adapter.id,
      ...(await healthCheckAdapter(ctx.cwd, config, adapter)),
    })));
    const backgroundDir = resolveBackgroundLogDir(ctx.cwd, config);
    const debugDir = config.debug?.enabled === false
      ? path.isAbsolute(config.debug?.logDir?.trim() || "") ? config.debug?.logDir?.trim() || "(disabled)" : path.join(ctx.cwd, config.debug?.logDir?.trim() || ".oh-my-opencode-pi-debug")
      : resolveDebugLogDir(ctx.cwd, config);
    const workflowStatePath = resolveWorkflowStatePath(ctx.cwd, config);
    const taskCount = fs.existsSync(backgroundDir) ? listBackgroundTasks(backgroundDir).length : 0;
    const providerAudit = auditPantheonProviderConfiguration(config);
    const report = buildDoctorReport({
      cwd: ctx.cwd,
      config: configResult,
      adapterHealth,
      tmuxAvailable: isTmuxBinaryAvailable(),
      inTmux: Boolean(process.env.TMUX),
      backgroundDir,
      backgroundDirExists: fs.existsSync(backgroundDir),
      debugDir,
      debugDirExists: fs.existsSync(debugDir),
      workflowStatePath,
      workflowStateExists: fs.existsSync(workflowStatePath),
      taskCount,
      providerAudit,
    });
    const hasError = configResult.diagnostics.some((item) => item.severity === "error") || adapterHealth.some((item) => item.status === "error");
    const hasWarning = configResult.diagnostics.some((item) => item.severity === "warning") || adapterHealth.some((item) => item.status === "warn") || providerAudit.warnings.length > 0 || !process.env.TMUX;
    presentPantheonCommandEditorOutput("/pantheon-doctor", report, ctx, {
      summary: hasError ? "Pantheon doctor found issues" : hasWarning ? "Pantheon doctor found warnings" : "Pantheon doctor passed",
      notifyMessage: hasError ? "Pantheon doctor found issues." : hasWarning ? "Pantheon doctor found warnings." : "Pantheon doctor passed.",
      status: hasError ? "error" : hasWarning ? "warning" : "success",
      modes: hasError || hasWarning
        ? ["widget-summary", "editor-report", "notify"]
        : ["widget-summary", "editor-report"],
    });
  }

  async function handlePantheonHooksCommand(_args: string, ctx: ExtensionContext) {
    presentPantheonCommandEditorOutput("/pantheon-hooks", summarizeOrchestrationSnapshot(orchestration.getSnapshot()), ctx, {
      summary: "Pantheon orchestration hook trace",
      notifyMessage: "Posted Pantheon orchestration hook trace to chat.",
    });
  }

  async function handlePantheonStatsCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const stats = readPantheonStats(ctx.cwd, config);
    const evalReport = readPantheonEvaluationReport(ctx.cwd, config);
    presentPantheonCommandEditorOutput("/pantheon-stats", renderPantheonStats(stats, evalReport), ctx, {
      summary: "Pantheon usage, reliability, and evaluation statistics",
      notifyMessage: "Posted Pantheon stats to chat.",
    });
  }

  async function handlePantheonVersionCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const report = await checkForPackageUpdates(config);
    if (report.status === "update-available" && config.updates?.notify !== false && report.latestVersion) {
      ctx.ui.setStatus(VERSION_STATUS_KEY, `Update available: ${report.currentVersion} → ${report.latestVersion}`);
    }
    presentPantheonCommandEditorOutput("/pantheon-version", renderPackageUpdateReport(report), ctx, {
      summary: report.updateAvailable ? `Update available: ${report.currentVersion} → ${report.latestVersion}` : `Pantheon version ${report.currentVersion}`,
      notifyMessage: "Posted package version report to chat.",
      status: report.status === "error" ? "error" : report.updateAvailable ? "warning" : report.status === "skipped" ? "warning" : "success",
    });
  }

  async function handlePantheonUpdateCheckCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const report = await checkForPackageUpdates(config, { force: true });
    if (report.status === "update-available" && config.updates?.notify !== false && report.latestVersion) {
      ctx.ui.setStatus(VERSION_STATUS_KEY, `Update available: ${report.currentVersion} → ${report.latestVersion}`);
    }
    presentPantheonCommandEditorOutput("/pantheon-update-check", renderPackageUpdateReport(report, true), ctx, {
      summary: report.updateAvailable ? `Refresh found ${report.latestVersion}` : `Package version check: ${report.status}`,
      notifyMessage: "Posted refreshed package version report to chat.",
      status: report.status === "error" ? "error" : report.updateAvailable ? "warning" : report.status === "skipped" ? "warning" : "success",
    });
  }

  async function handlePantheonSpecStudioCommand(_args: string, ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify("/pantheon-spec-studio requires interactive mode", "error");
      return;
    }
    const kind = await showPantheonSelect(ctx, "Spec studio template", [
      { value: "feature", label: "feature", description: "Product or capability delivery spec." },
      { value: "refactor", label: "refactor", description: "Architecture or maintainability-driven technical plan." },
      { value: "investigation", label: "investigation", description: "Unknowns, questions, and research-driven brief." },
      { value: "incident", label: "incident", description: "Debugging, outage, or remediation plan." },
    ]);
    if (!kind) return;
    const title = await ctx.ui.input("Spec title", "Project Specification");
    if (!title?.trim()) return;
    const focusAreas = await ctx.ui.input("Focus areas", "Optional: architecture, UX, rollout, risks, etc.");
    ctx.ui.setEditorText(buildSpecStudioTemplate(kind, title.trim(), { focusAreas: focusAreas ?? "", context: `Workspace: ${ctx.cwd}` }));
    ctx.ui.notify(`Loaded ${kind} spec studio template into editor.`, "info");
  }

  async function handlePantheonBootstrapCommand(_args: string, ctx: ExtensionContext) {
    const result = bootstrapPantheonProject(ctx.cwd);
    ctx.ui.setEditorText(buildBootstrapGuide(ctx.cwd, result.files));
    ctx.ui.notify(result.files.length > 0 ? `Bootstrapped Pantheon project files in ${result.rootDir}.` : "Pantheon bootstrap skipped existing files (use the tool with force to overwrite).", "info");
  }

  async function handlePantheonDebugCommand(
    args: string,
    ctx: ExtensionContext,
    options?: { localOnly?: boolean },
  ) {
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
    presentPantheonCommandEditorOutput("/pantheon-debug", `Trace: ${trace.id}\nDirectory: ${path.join(debugDir, trace.id)}\n\nSummary:\n${summaryText}\n\nEvents:\n${eventText}`, ctx, {
      summary: `Debug trace ${trace.id}`,
      notifyMessage: options?.localOnly === true
        ? `Loaded debug trace ${trace.id} into editor.`
        : `Posted debug trace ${trace.id} to chat.`,
      modes: options?.localOnly === true ? ["widget-summary", "editor-report", "notify"] : undefined,
    });
  }

  function buildBackgroundTaskSelectItems(tasks: BackgroundTaskRecord[], staleAfterMs = 20000) {
    return tasks.slice(0, 20).map((task) => ({
      value: task.id,
      label: `${task.id} · ${task.agent} · ${isTaskStale(task, staleAfterMs) ? `${task.status}/stale` : task.status}`,
      description: previewText(task.summary ?? task.task, 96),
    }));
  }

  async function selectBackgroundTaskId(
    ctx: ExtensionContext,
    title: string,
    tasks: BackgroundTaskRecord[],
    emptyMessage: string,
    staleAfterMs = 20000,
  ): Promise<string | undefined> {
    if (!ctx.hasUI) return undefined;
    if (tasks.length === 0) {
      ctx.ui.notify(emptyMessage, "info");
      return undefined;
    }
    return await showPantheonSelect(ctx, title, buildBackgroundTaskSelectItems(tasks, staleAfterMs)) ?? undefined;
  }

  async function handlePantheonAttachCommand(args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    let taskId = args.trim();
    if (!taskId) {
      taskId = await selectBackgroundTaskId(
        ctx,
        "Attach background task pane",
        listBackgroundTasks(taskDir).filter((task) => task.status === "queued" || task.status === "running"),
        "No active background tasks. Start one with pantheon_background or use /pantheon to launch work.",
      ) ?? "";
      if (!taskId) return;
    }
    const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
    if (!task) {
      ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
      return;
    }
    if (!process.env.TMUX || !config.multiplexer?.tmux) {
      ctx.ui.notify("tmux attach requires running inside tmux with multiplexer.tmux enabled. Use /pantheon-watch or /pantheon-log instead.", "error");
      return;
    }
    const updated = attachBackgroundTaskPane(task, config.multiplexer, ctx.cwd);
    if (!updated.paneId) {
      ctx.ui.notify(`Unable to open tmux pane for ${updated.id}. Try /pantheon-watch ${updated.id} for a non-tmux fallback.`, "error");
      return;
    }
    ctx.ui.notify(`Attached tmux pane ${updated.paneId} for ${updated.id}.`, "info");
  }

  async function handlePantheonAttachAllCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    const tasks = attachAllBackgroundTaskPanes(listBackgroundTasks(taskDir), config.multiplexer, ctx.cwd);
    const active = tasks.filter((task) => task.status === "queued" || task.status === "running");
    ctx.ui.notify(active.length > 0
      ? `Attached/reused panes for ${active.length} active background task${active.length === 1 ? "" : "s"}.`
      : "No active background tasks to attach. Use pantheon_background to start detached work.", "info");
  }

  async function handlePantheonWatchCommand(args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const staleAfterMs = config.background?.staleAfterMs ?? 20000;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer, staleAfterMs);
    let taskId = args.trim();
    if (!taskId) {
      taskId = await selectBackgroundTaskId(
        ctx,
        "Watch background task",
        listBackgroundTasks(taskDir),
        "No background tasks yet. Start one with pantheon_background or inspect /pantheon-overview.",
        staleAfterMs,
      ) ?? "";
      if (!taskId) return;
    }
    const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
    if (!task) {
      ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
      return;
    }
    presentPantheonCommandEditorOutput("/pantheon-watch", renderBackgroundWatch(task, 80, staleAfterMs), ctx, {
      summary: `Live task state for ${task.id}`,
      notifyMessage: `Loaded watch view for ${task.id}.`,
      status: task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs) ? "warning" : "success",
    });
  }

  async function handlePantheonResultCommand(args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const staleAfterMs = config.background?.staleAfterMs ?? 20000;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    let taskId = args.trim();
    if (!taskId) {
      taskId = await selectBackgroundTaskId(
        ctx,
        "Background task result",
        listBackgroundTasks(taskDir),
        "No background tasks yet. Start one with pantheon_background or inspect /pantheon-overview.",
        staleAfterMs,
      ) ?? "";
      if (!taskId) return;
    }
    const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
    if (!task) {
      ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
      return;
    }
    const text = renderBackgroundResult(task, { staleAfterMs });
    presentPantheonCommandEditorOutput("/pantheon-result", text, ctx, {
      summary: `Final result for ${task.id}`,
      notifyMessage: `Loaded result for ${task.id} into editor.`,
      status: task.status === "failed" || task.status === "cancelled" ? "warning" : "success",
    });
  }

  async function handlePantheonTodosCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const state = readWorkflowState(ctx.cwd, config);
    presentPantheonCommandEditorOutput("/pantheon-todos", renderWorkflowState(state), ctx, {
      summary: state.uncheckedTodos.length > 0
        ? `${state.uncheckedTodos.length} persisted todo${state.uncheckedTodos.length === 1 ? "" : "s"} ready to resume`
        : "No persisted todos",
      notifyMessage: `Loaded Pantheon workflow state (${state.uncheckedTodos.length} unchecked todo${state.uncheckedTodos.length === 1 ? "" : "s"}).`,
    });
    updatePantheonDashboard(ctx, config);
  }

  async function handlePantheonOverviewCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    const tasks = maybeStartQueuedTasks(ctx.cwd, taskDir);
    const state = readWorkflowState(ctx.cwd, config);
    presentPantheonCommandEditorOutput("/pantheon-overview", `${renderBackgroundOverview(tasks)}\n\n---\n\n${renderWorkflowState(state)}`, ctx, {
      summary: tasks.length > 0 ? `Overview of ${tasks.length} background task${tasks.length === 1 ? "" : "s"}` : "Workflow overview with no background tasks",
      notifyMessage: "Loaded Pantheon overview into editor.",
    });
    updatePantheonDashboard(ctx, config);
  }

  async function handlePantheonSidebarCommand(_args: string, ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify("/pantheon-sidebar requires interactive mode", "error");
      return;
    }
    const getSnapshot = () => {
      const configResult = loadPantheonConfig(ctx.cwd);
      latestConfig = configResult.config;
      latestWarningCount = configResult.warnings.length;
      const taskDir = ensureDir(configResult.config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, configResult.config.multiplexer, configResult.config.background?.staleAfterMs ?? 20000);
      const tasks = configResult.config.background?.enabled === false ? [] : maybeStartQueuedTasks(ctx.cwd, taskDir);
      const state = configResult.config.workflow?.persistTodos === false
        ? { updatedAt: 0, uncheckedTodos: [] }
        : readWorkflowState(ctx.cwd, configResult.config);
      return {
        config: configResult.config,
        state,
        tasks,
        autoContinueEnabled,
        configWarnings: configResult.warnings.length,
      };
    };

    const action = await showPantheonSidebar(ctx, getSnapshot);
    if (!action) return;
    if (action.action === "overview") {
      await handlePantheonOverviewCommand("", ctx);
      return;
    }
    if (action.action === "launcher") {
      ctx.ui.notify("Sidebar closed. Run /pantheon to reopen the launcher.", "info");
      return;
    }
    if (action.action === "task-actions" && action.taskId) {
      await handlePantheonBackgroundActionsCommand(action.taskId, ctx);
    }
  }

  async function handlePantheonResumeCommand(_args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    const tasks = listBackgroundTasks(taskDir);
    const state = readWorkflowState(ctx.cwd, config);
    const text = buildResumeContext(state, tasks);
    presentPantheonCommandEditorOutput("/pantheon-resume", text, ctx, {
      summary: state.uncheckedTodos.length > 0
        ? `Resume ${state.uncheckedTodos.length} todo${state.uncheckedTodos.length === 1 ? "" : "s"} with ${tasks.length} recent task${tasks.length === 1 ? "" : "s"}`
        : `Resume from ${tasks.length} recent background task${tasks.length === 1 ? "" : "s"}`,
      notifyMessage: "Loaded Pantheon resume context into editor.",
    });
    updatePantheonDashboard(ctx, config);
  }

  async function handlePantheonRetryCommand(args: string, ctx: ExtensionContext) {
    const config = loadPantheonConfig(ctx.cwd).config;
    const staleAfterMs = config.background?.staleAfterMs ?? 20000;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer);
    let taskId = args.trim();
    if (!taskId) {
      taskId = await selectBackgroundTaskId(
        ctx,
        "Retry background task",
        listBackgroundTasks(taskDir).filter((task) => isTerminalTaskStatus(task.status) || isTaskStale(task, staleAfterMs)),
        "No retryable background tasks found. Use /pantheon-backgrounds to inspect recent work.",
        staleAfterMs,
      ) ?? "";
      if (!taskId) return;
    }
    const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
    if (!task) {
      ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
      return;
    }
    if (!isTerminalTaskStatus(task.status) && !isTaskStale(task, staleAfterMs)) {
      ctx.ui.notify(`Task ${task.id} is ${task.status}; retry is available only for failed, cancelled, completed, or stale work.`, "error");
      return;
    }
    const retried = retryBackgroundTask(ctx.cwd, task, {
      taskDir,
      randomId,
      onEnqueue: (taskId) => rememberBackgroundTaskId(ctx.cwd, config, taskId),
    });
    if (!retried) {
      ctx.ui.notify(`Unable to retry ${task.id}: missing or invalid spec. Inspect /pantheon-result ${task.id} for details.`, "error");
      return;
    }
    updatePantheonDashboard(ctx, config);
    ctx.ui.notify(`Retried ${task.id} as ${retried.id}.`, "info");
  }

  async function handlePantheonBackgroundActionsCommand(args: string, ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      ctx.ui.notify("/pantheon-task-actions requires interactive mode", "error");
      return;
    }
    const config = loadPantheonConfig(ctx.cwd).config;
    const staleAfterMs = config.background?.staleAfterMs ?? 20000;
    const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
    reconcileBackgroundTasks(taskDir, config.multiplexer, staleAfterMs);
    let taskId = args.trim();
    if (!taskId) {
      taskId = await selectBackgroundTaskId(
        ctx,
        "Background task actions",
        listBackgroundTasks(taskDir),
        "No background tasks yet. Start one with pantheon_background or inspect /pantheon-overview.",
        staleAfterMs,
      ) ?? "";
      if (!taskId) return;
    }
    const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
    if (!task) {
      ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
      return;
    }
    const action = await showPantheonSelect(ctx, `Background task actions · ${task.id} · ${task.agent}`, [
      { value: "watch", label: "Inspect · /pantheon-watch", description: "Live state, heartbeat, and recent log tail." },
      { value: "result", label: "Inspect · /pantheon-result", description: "Final summary and next recovery actions." },
      { value: "log", label: "Inspect · /pantheon-log", description: "Raw recent log output." },
      ...(task.status === "queued" || task.status === "running"
        ? [{ value: "cancel", label: "Recover · /pantheon-cancel", description: "Cancel the active background task." }]
        : []),
      ...(task.status === "queued" || task.status === "running"
        ? [{ value: "attach", label: "Inspect · /pantheon-attach", description: "Open or reuse a tmux pane for live logs." }]
        : []),
      ...(isTerminalTaskStatus(task.status) || isTaskStale(task, staleAfterMs)
        ? [{ value: "retry", label: "Recover · /pantheon-retry", description: "Requeue the task from its saved spec." }]
        : []),
    ]);
    if (!action) return;
    if (action === "watch") {
      await handlePantheonWatchCommand(task.id, ctx);
      return;
    }
    if (action === "result") {
      await handlePantheonResultCommand(task.id, ctx);
      return;
    }
    if (action === "log") {
      const logText = tailLog(task.logPath);
      presentPantheonCommandEditorOutput("/pantheon-log", logText, ctx, {
        summary: `Recent log for ${task.id}`,
        notifyMessage: `Loaded log tail for ${task.id} into editor.`,
      });
      return;
    }
    if (action === "cancel") {
      const updated = cancelBackgroundTask(task, config.multiplexer);
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Cancelled ${updated.id}`, "info");
      return;
    }
    if (action === "attach") {
      await handlePantheonAttachCommand(task.id, ctx);
      return;
    }
    if (action === "retry") {
      await handlePantheonRetryCommand(task.id, ctx);
    }
  }

  async function handlePantheonCouncilCommand(_args: string, ctx: ExtensionContext) {
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
    if (!executePantheonCouncilCommand) {
      ctx.ui.notify("Pantheon council is not available.", "error");
      return;
    }
    const result = await streamPantheonCommandProgress(
      "/pantheon-council",
      `Council preset ${preset} is running`,
      (onUpdate) => executePantheonCouncilCommand!({ prompt: question, preset }, undefined, onUpdate, ctx),
      ctx,
      presentPantheonCommandProgress,
    );
    presentPantheonCommandResult("/pantheon-council", result, ctx, `Council completed with preset ${preset}.`, `Council failed with preset ${preset}.`);
  }

  async function handlePantheonDelegateCommand(_args: string, ctx: ExtensionContext) {
    const discovery = discoverPantheonAgents(ctx.cwd, true);
    const agentName = await showPantheonSelect(
      ctx,
      "Choose specialist — investigate, research, decide, design, or implement",
      discovery.agents
        .filter((agent) => !["councillor", "council-master"].includes(agent.name))
        .map((agent) => ({
          value: agent.name,
          label: buildPantheonSpecialistPickerLabel(agent.name),
          description: `${buildPantheonSpecialistPickerDescription(agent.name, describePantheonSpecialist(agent.name, agent.description))} [${agent.source}]`,
        })),
      "↑↓ navigate • enter select • esc cancel • use Help in /pantheon if you are unsure",
    );
    if (!agentName) return;
    const task = await ctx.ui.input("Delegation task", `Task for ${agentName}`);
    if (!task?.trim()) return;
    if (!executePantheonDelegateCommand) {
      ctx.ui.notify("Pantheon delegate is not available.", "error");
      return;
    }
    const result = await streamPantheonCommandProgress(
      "/pantheon",
      `Delegating to ${agentName}`,
      (onUpdate) => executePantheonDelegateCommand!({ agent: agentName, task, includeProjectAgents: true }, undefined, onUpdate, ctx),
      ctx,
      presentPantheonCommandProgress,
    );
    presentPantheonCommandResult("/pantheon", result, ctx, `Delegation to ${agentName} completed.`, `Delegation to ${agentName} failed.`);
  }

  async function handlePantheonAsCommand(args: string, ctx: ExtensionContext) {
    const [agentName, ...taskParts] = args.trim().split(/\s+/).filter(Boolean);
    if (!agentName || taskParts.length === 0) {
      ctx.ui.notify("Usage: /pantheon-as <agent> <task>", "error");
      return;
    }
    if (!executePantheonDelegateCommand) {
      ctx.ui.notify("Pantheon delegate is not available.", "error");
      return;
    }
    const result = await streamPantheonCommandProgress(
      "/pantheon-as",
      `Delegating to ${agentName}`,
      (onUpdate) => executePantheonDelegateCommand!({ agent: agentName, task: taskParts.join(" "), includeProjectAgents: true }, undefined, onUpdate, ctx),
      ctx,
      presentPantheonCommandProgress,
    );
    presentPantheonCommandResult("/pantheon-as", result, ctx, `Delegation to ${agentName} completed.`, `Delegation to ${agentName} failed.`);
  }

  async function handleReviewCommand(args: string, ctx: ExtensionContext) {
    const resolved = await resolveReviewCommandRequest(args, ctx);
    if (resolved.error) {
      ctx.ui.notify(resolved.error, "error");
      return;
    }
    if (!resolved.request) return;
    pi.sendUserMessage(buildReviewCommandPrompt(resolved.request, ctx.cwd));
    ctx.ui.notify(`Queued review prompt for ${resolved.request.label}.`, "info");
  }

  async function handlePantheonSubagentsCommand(_args: string, ctx: ExtensionContext) {
    if (!latestSubagentActivity || latestSubagentActivity.entries.length === 0) {
      ctx.ui.notify("No recent subagent activity available.", "info");
      return;
    }
    if (!ctx.hasUI) {
      const summary = latestSubagentActivity.entries
        .map((entry) => `${entry.label} — ${buildSubagentActivityPreview(entry.result)}`)
        .join("\n");
      ctx.ui.setEditorText(`${latestSubagentActivity.title}${latestSubagentActivity.subtitle ? ` — ${latestSubagentActivity.subtitle}` : ""}\n\n${summary}`);
      return;
    }

    const selection = await showPantheonSubagentInspector(
      ctx,
      () => buildSubagentInspectorSnapshot(latestSubagentActivity),
    );
    if (!selection) return;
    const entry = latestSubagentActivity.entries[selection.index];
    if (!entry) {
      ctx.ui.notify(`No subagent entry found: ${selection.index}.`, "error");
      return;
    }
    const action = selection.action;
    if (action === "trace" && entry.result.debugTraceId) {
      await handlePantheonDebugCommand(entry.result.debugTraceId, ctx, { localOnly: true });
      return;
    }
    if (action === "summary") {
      ctx.ui.setEditorText(buildSubagentArtifactText(entry, "Summary JSON", entry.result.debugSummaryPath, "(no summary file)", { maxBytes: SUBAGENT_DETAIL_SUMMARY_PREVIEW_BYTES }));
      ctx.ui.notify(`Loaded summary preview for ${entry.label}.`, "info");
      return;
    }
    if (action === "stdout") {
      ctx.ui.setEditorText(buildSubagentOutputText(entry, { maxBytes: SUBAGENT_DETAIL_LOG_PREVIEW_BYTES, mode: "tail" }));
      ctx.ui.notify(`Loaded output preview for ${entry.label}.`, "info");
      return;
    }
    if (action === "stderr") {
      if (entry.result.debugStderrPath) {
        ctx.ui.setEditorText(buildSubagentArtifactText(entry, "Stderr", entry.result.debugStderrPath, entry.result.stderr || "(no stderr log)", { maxBytes: SUBAGENT_DETAIL_LOG_PREVIEW_BYTES, mode: "tail" }));
      } else {
        ctx.ui.setEditorText([`Subagent: ${entry.label}`, "Artifact: Stderr", "", entry.result.stderr || "(no stderr log)"].join("\n"));
      }
      ctx.ui.notify(`Loaded stderr tail for ${entry.label}.`, "info");
      return;
    }
    if (action === "paths") {
      ctx.ui.setEditorText(buildSubagentPathsText(entry));
      ctx.ui.notify(`Loaded artifact paths for ${entry.label}.`, "info");
      return;
    }
    ctx.ui.setEditorText(buildSubagentDetailText(entry));
    ctx.ui.notify(`Loaded subagent details for ${entry.label}.`, "info");
  }

  registerPantheonNamedCommands(pi.registerCommand.bind(pi), {
    handleReviewCommand,
    handlePantheonAgentsCommand,
    handlePantheonCouncilCommand,
    handlePantheonSpecStudioCommand,
    handlePantheonBootstrapCommand,
    handlePantheonAsCommand,
    handlePantheonAttachCommand,
    handlePantheonAttachAllCommand,
    handlePantheonSubagentsCommand,
    handlePantheonWatchCommand,
    handlePantheonResultCommand,
    handlePantheonTodosCommand,
    handlePantheonOverviewCommand,
    handlePantheonSidebarCommand,
    handlePantheonResumeCommand,
    handlePantheonRetryCommand,
    handlePantheonBackgroundActionsCommand,
    reviewModes: REVIEW_MODES,
  });

  pi.registerCommand("pantheon", {
    description: "Interactive Pantheon launcher",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pantheon requires interactive mode", "error");
        return;
      }

      const configResult = loadPantheonConfig(ctx.cwd);
      const taskDir = ensureDir(configResult.config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const tasks = reconcileBackgroundTasks(taskDir, configResult.config.multiplexer, configResult.config.background?.staleAfterMs ?? 20000);
      const workflowState = readWorkflowState(ctx.cwd, configResult.config);
      const staleAfterMs = configResult.config.background?.staleAfterMs ?? 20000;
      const failedTask = tasks.find((task) => task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs));
      const activeTask = tasks.find((task) => task.status === "queued" || task.status === "running");
      const recommendedItems = [
        ...(failedTask ? [{ value: "task-actions", label: "Recommended · Recover failed background task", description: `${failedTask.id} — /pantheon-task-actions ${failedTask.id}` }] : []),
        ...(activeTask ? [{ value: "watch", label: "Recommended · Watch active background task", description: `${activeTask.id} — /pantheon-watch ${activeTask.id}` }] : []),
        ...(workflowState.uncheckedTodos.length > 0 ? [{ value: "resume", label: "Recommended · Resume prior work", description: `${workflowState.uncheckedTodos.length} persisted todo${workflowState.uncheckedTodos.length === 1 ? "" : "s"} — /pantheon-resume` }] : []),
        ...(configResult.warnings.length > 0 ? [{ value: "config", label: "Recommended · Review config warnings", description: `${configResult.warnings.length} warning${configResult.warnings.length === 1 ? "" : "s"} — /pantheon-config` }] : []),
      ];
      const recommendedValues = new Set(recommendedItems.map((item) => item.value));
      let action = await showPantheonSelect(ctx, "Pantheon — choose next move", [
        ...recommendedItems,
        { value: "delegate", label: "Start work · Delegate to specialist", description: "Choose the right lane: investigate, research, decide, design, or implement." },
        { value: "help-specialist", label: "Help · Which specialist should I use?", description: "Open a quick Pantheon guide for choosing Explorer, Librarian, Oracle, Designer, Fixer, or Council." },
        { value: "council", label: "Start work · Ask council", description: "Get multiple perspectives and a synthesized recommendation." },
        { value: "review", label: "Review · Review code changes", description: "Launch the structured diff review helper for local changes, commits, or pull requests." },
        { value: "spec-studio", label: "Plan · Open spec studio", description: "Create an editor-first brief for feature, refactor, investigation, or incident work." },
        ...(!recommendedValues.has("resume") ? [{ value: "resume", label: "Resume · Pick up prior work", description: "Build a re-entry brief from persisted todos and recent background tasks." }] : []),
        ...(!recommendedValues.has("task-actions") ? [{ value: "task-actions", label: "Tasks · Inspect or recover background work", description: "Choose watch, result, log, attach, cancel, or retry from one task menu." }] : []),
        { value: "doctor", label: "Troubleshoot · Run doctor", description: "Check config, adapters, tmux, and background storage health." },
        { value: "advanced", label: "Advanced · More commands and diagnostics", description: "Open lower-frequency setup, inspection, and maintainer commands." },
      ]);
      if (!action) return;

      if (action === "advanced") {
        action = await showPantheonSelect(ctx, "Pantheon — advanced commands", [
          { value: "config", label: "Config · Open config report", description: "Inspect merged config, validation warnings, and active presets." },
          { value: "bootstrap", label: "Setup · Bootstrap Pantheon", description: "Scaffold project-local Pantheon config, adapters, prompts, and agent directories." },
          { value: "agents", label: "Inspect · Specialist guide", description: "Review Pantheon specialist roles, best-fit tasks, and active overrides." },
          { value: "skills", label: "Setup · Skills guidance", description: "Show skill policy guidance and a starter config snippet." },
          { value: "adapter-health", label: "Setup · Adapter health", description: "Inspect adapter auth/readiness before relying on external research sources." },
          { value: "overview", label: "Inspect · Workflow overview", description: "See workflow state and background task activity together." },
          { value: "sidebar", label: "Inspect · Sidebar overlay", description: "Open an experimental right-side Pantheon overlay." },
          { value: "watch", label: "Inspect · Watch background task", description: "Open live metadata plus a recent log tail for a detached task." },
          { value: "result", label: "Inspect · Background task result", description: "Open the latest result summary for a detached task." },
          { value: "attach", label: "Inspect · Attach task pane", description: "Open or reopen a tmux pane for a running task log." },
          { value: "attach-all", label: "Inspect · Attach all running tasks", description: "Open or reuse panes for all queued/running background tasks." },
          { value: "todos", label: "Inspect · Persisted workflow todos", description: "Review carried-over unchecked tasks from prior work." },
          { value: "subagents", label: "Inspect · Subagent activity", description: "Inspect live/recent delegate or council subagent details and jump to full traces." },
          { value: "debug", label: "Recover · Inspect debug trace", description: "Open recent foreground delegation/council traces and inspect why they failed." },
          { value: "retry", label: "Recover · Retry background task", description: "Requeue completed, failed, cancelled, or stale detached work." },
          { value: "hooks", label: "Diagnostics · Hook trace", description: "Inspect Pantheon orchestration middleware ordering and restored trace state." },
          { value: "stats", label: "Diagnostics · Stats", description: "Inspect Pantheon usage and reliability statistics." },
          { value: "version", label: "Diagnostics · Package version", description: "Inspect the installed package version and cached update information." },
          { value: "update-check", label: "Diagnostics · Refresh update check", description: "Force a fresh check for the latest published package version." },
        ], "↑↓ navigate • enter select • esc back");
        if (!action) return;
      }

      if (action === "agents") {
        await handlePantheonAgentsCommand("", ctx);
        return;
      }
      if (action === "help-specialist") {
        await handlePantheonSpecialistHelp(ctx);
        return;
      }
      if (action === "review") {
        await handleReviewCommand("", ctx);
        return;
      }
      if (action === "spec-studio") {
        await handlePantheonSpecStudioCommand("", ctx);
        return;
      }
      if (action === "bootstrap") {
        await handlePantheonBootstrapCommand("", ctx);
        return;
      }
      if (action === "debug") {
        await handlePantheonDebugCommand("", ctx);
        return;
      }
      if (action === "subagents") {
        await handlePantheonSubagentsCommand("", ctx);
        return;
      }
      if (action === "attach") {
        await handlePantheonAttachCommand("", ctx);
        return;
      }
      if (action === "result") {
        await handlePantheonResultCommand("", ctx);
        return;
      }
      if (action === "watch") {
        await handlePantheonWatchCommand("", ctx);
        return;
      }
      if (action === "task-actions") {
        await handlePantheonBackgroundActionsCommand("", ctx);
        return;
      }
      if (action === "attach-all") {
        await handlePantheonAttachAllCommand("", ctx);
        return;
      }
      if (action === "todos") {
        await handlePantheonTodosCommand("", ctx);
        return;
      }
      if (action === "retry") {
        await handlePantheonRetryCommand("", ctx);
        return;
      }
      if (action === "overview") {
        await handlePantheonOverviewCommand("", ctx);
        return;
      }
      if (action === "sidebar") {
        await handlePantheonSidebarCommand("", ctx);
        return;
      }
      if (action === "resume") {
        await handlePantheonResumeCommand("", ctx);
        return;
      }

      if (action === "config") {
        const configResult = loadPantheonConfig(ctx.cwd);
        latestConfig = configResult.config;
        latestWarningCount = configResult.warnings.length;
        updatePantheonDashboard(ctx, configResult.config);
        const summary = configResult.warnings.length > 0 ? `Config report with ${configResult.warnings.length} warning${configResult.warnings.length === 1 ? "" : "s"}` : "Config report";
        const report = buildConfigReport(configResult);
        presentPantheonCommandEditorOutput("/pantheon-config", report, ctx, {
          summary,
          notifyMessage: configResult.warnings.length > 0 ? `Loaded config report with ${configResult.warnings.length} warning${configResult.warnings.length === 1 ? "" : "s"}.` : "Loaded config report into editor.",
          status: configResult.warnings.length > 0 ? "warning" : "success",
        });
        await showPantheonReportModal(ctx, "Config report", summary, report);
        return;
      }

      if (action === "stats") {
        await handlePantheonStatsCommand("", ctx);
        return;
      }
      if (action === "version") {
        await handlePantheonVersionCommand("", ctx);
        return;
      }
      if (action === "update-check") {
        await handlePantheonUpdateCheckCommand("", ctx);
        return;
      }
      if (action === "hooks") {
        await handlePantheonHooksCommand("", ctx);
        return;
      }
      if (action === "adapter-health") {
        await handlePantheonAdapterHealthCommand("", ctx);
        return;
      }
      if (action === "doctor") {
        await handlePantheonDoctorCommand("", ctx);
        return;
      }

      if (action === "skills") {
        await handlePantheonSkillsCommand("", ctx);
        return;
      }

      if (action === "council") {
        await handlePantheonCouncilCommand("", ctx);
        return;
      }

      await handlePantheonDelegateCommand("", ctx);
    },
  });

  pi.registerCommand("pantheon-config", {
    description: "Show oh-my-opencode-pi config sources and warnings",
    handler: async (_args, ctx) => {
      const configResult = loadPantheonConfig(ctx.cwd);
      latestConfig = configResult.config;
      latestWarningCount = configResult.warnings.length;
      updatePantheonDashboard(ctx, configResult.config);
      const summary = configResult.warnings.length > 0 ? `Config report with ${configResult.warnings.length} warning${configResult.warnings.length === 1 ? "" : "s"}` : "Config report";
      const report = buildConfigReport(configResult);
      presentPantheonCommandEditorOutput("/pantheon-config", report, ctx, {
        summary,
        notifyMessage: configResult.warnings.length > 0 ? `Loaded config report with ${configResult.warnings.length} warning${configResult.warnings.length === 1 ? "" : "s"}.` : "Loaded config report into editor.",
        status: configResult.warnings.length > 0 ? "warning" : "success",
      });
      await showPantheonReportModal(ctx, "Config report", summary, report);
    },
  });

  pi.registerCommand("pantheon-skills", {
    description: "Show effective skill/cartography guidance and a starter config snippet",
    handler: handlePantheonSkillsCommand,
  });

  pi.registerCommand("pantheon-adapters", {
    description: "List registered Pantheon research adapters and effective policy for this session",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const { agentName, adapters, registered, loadErrors } = await getAllowedAdapters(ctx.cwd, config);
      presentPantheonCommandEditorOutput("/pantheon-adapters", buildAdapterPolicyReport({ agentName, adapters, registered, loadErrors }), ctx, {
        summary: `Adapter policy for ${agentName ?? "interactive"}`,
        notifyMessage: "Loaded adapter policy report into editor.",
        status: loadErrors.length > 0 ? "warning" : "success",
      });
    },
  });

  pi.registerCommand("pantheon-adapter-health", {
    description: "Check adapter auth/readiness and health hints for the current session",
    handler: handlePantheonAdapterHealthCommand,
  });

  pi.registerCommand("pantheon-doctor", {
    description: "Run Pantheon health checks across config, adapters, tmux, and background storage",
    handler: handlePantheonDoctorCommand,
  });

  pi.registerCommand("pantheon-hooks", {
    description: "Show Pantheon orchestration hook ordering, tracing, and restored session middleware state",
    handler: handlePantheonHooksCommand,
  });

  pi.registerCommand("pantheon-stats", {
    description: "Show Pantheon usage and reliability statistics",
    handler: handlePantheonStatsCommand,
  });

  pi.registerCommand("pantheon-version", {
    description: "Show the installed package version and cached update information",
    handler: handlePantheonVersionCommand,
  });

  pi.registerCommand("pantheon-update-check", {
    description: "Force a fresh package update check and show the latest package version report",
    handler: handlePantheonUpdateCheckCommand,
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
    description: "Show a Pantheon debug trace in chat (latest by default)",
    handler: handlePantheonDebugCommand,
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
      presentPantheonCommandEditorOutput("/pantheon-backgrounds", renderBackgroundOverview(tasks, 20, config.background?.staleAfterMs ?? 20000), ctx, {
        summary: `Background overview with ${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
        notifyMessage: "Loaded Pantheon background overview into editor.",
      });
    },
  });

  pi.registerCommand("pantheon-multiplexer", {
    description: "Inspect tmux/multiplexer status for Pantheon background work",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const tasks = reconcileBackgroundTasks(taskDir, config.multiplexer);
      const text = renderMultiplexerStatus(ctx.cwd, config.multiplexer, tasks);
      presentPantheonCommandEditorOutput("/pantheon-multiplexer", text, ctx, {
        summary: `Multiplexer status for ${getMultiplexerWindowName(ctx.cwd, config.multiplexer)}`,
        notifyMessage: `Loaded Pantheon multiplexer status for ${getMultiplexerWindowName(ctx.cwd, config.multiplexer)}.`,
      });
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
        if (tasks.length === 0) {
          ctx.ui.notify("No active background tasks to cancel. Use /pantheon-backgrounds to inspect recent work.", "info");
          return;
        }
        const selected = await showPantheonSelect(
          ctx,
          "Cancel background task",
          buildBackgroundTaskSelectItems(tasks, config.background?.staleAfterMs ?? 20000),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-cancel <taskId>. Use /pantheon-backgrounds to inspect recent ids.", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
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
        const tasks = listBackgroundTasks(taskDir);
        if (tasks.length === 0) {
          ctx.ui.notify("No background tasks yet. Start one with pantheon_background or inspect /pantheon-overview.", "info");
          return;
        }
        const selected = await showPantheonSelect(
          ctx,
          "Background task log",
          buildBackgroundTaskSelectItems(tasks, config.background?.staleAfterMs ?? 20000),
        );
        if (!selected) return;
        taskId = selected;
      }
      if (!taskId) {
        ctx.ui.notify("Usage: /pantheon-log <taskId>. Use /pantheon-backgrounds to inspect recent ids.", "error");
        return;
      }
      const task = listBackgroundTasks(taskDir).find((item) => item.id === taskId);
      if (!task) {
        ctx.ui.notify(`No task found: ${taskId}. Use /pantheon-backgrounds to inspect recent ids.`, "error");
        return;
      }
      presentPantheonCommandEditorOutput("/pantheon-log", tailLog(task.logPath), ctx, {
        summary: `Recent log for ${task.id}`,
        notifyMessage: `Loaded log tail for ${task.id} into editor.`,
      });
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
    handler: handlePantheonRetryCommand,
  });

  pi.registerCommand("pantheon-cleanup", {
    description: "Remove terminal background task artifacts",
    handler: async (_args, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer);
      const result = cleanupBackgroundArtifacts(taskDir, { keepCount: 0 });
      updatePantheonDashboard(ctx, config);
      ctx.ui.notify(`Removed ${result.removed} terminal task artifacts. Kept ${result.kept}.`, "info");
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
      const updated = attachBackgroundTaskPane(task, config.multiplexer, ctx.cwd);
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
    name: "pantheon_background_watch",
    label: "Pantheon Background Watch",
    description: "Inspect live background task metadata, heartbeat state, and recent log tail together.",
    parameters: BackgroundLogParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      reconcileBackgroundTasks(taskDir, config.multiplexer, config.background?.staleAfterMs ?? 20000);
      const task = listBackgroundTasks(taskDir).find((item) => item.id === params.taskId);
      if (!task) return { content: [{ type: "text", text: `No task found: ${params.taskId}` }], details: undefined, isError: true };
      return { content: [{ type: "text", text: renderBackgroundWatch(task, params.lines ?? 80, config.background?.staleAfterMs ?? 20000) }], details: task };
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
      const text = renderBackgroundResult(task, {
        includeLogTail: params.includeLogTail,
        logLines: params.logLines,
        staleAfterMs: config.background?.staleAfterMs ?? 20000,
      });
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
    name: "pantheon_spec_template",
    label: "Pantheon Spec Template",
    description: "Generate an editor-first spec studio template for feature, refactor, investigation, or incident work.",
    parameters: SpecTemplateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = buildSpecStudioTemplate(params.kind, params.title, { context: params.context, focusAreas: params.focusAreas });
      return { content: [{ type: "text", text }], details: { kind: params.kind, title: params.title } };
    },
  });

  pi.registerTool({
    name: "pantheon_bootstrap",
    label: "Pantheon Bootstrap",
    description: "Scaffold project-local Pantheon config, adapters, prompts, and agents directories.",
    parameters: BootstrapParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = bootstrapPantheonProject(ctx.cwd, { force: params.force });
      const guide = buildBootstrapGuide(ctx.cwd, result.files);
      return { content: [{ type: "text", text: guide }], details: result };
    },
  });

  registerPantheonCodeTools(pi.registerTool.bind(pi));

  pi.registerTool({
    name: "pantheon_stats",
    label: "Pantheon Stats",
    description: "Report persisted Pantheon usage, latency, and failure statistics.",
    promptSnippet: "Inspect recent Pantheon reliability and usage diagnostics before changing workflows or defaults.",
    parameters: StatsParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const stats = readPantheonStats(ctx.cwd, config);
      const evalReport = readPantheonEvaluationReport(ctx.cwd, config);
      return { content: [{ type: "text", text: renderPantheonStats(stats, evalReport) }], details: { stats, evalReport } };
    },
  });

  pi.registerTool({
    name: "pantheon_hook_trace",
    label: "Pantheon Hook Trace",
    description: "Inspect Pantheon orchestration middleware activity, hook ordering, and restored session trace state.",
    promptSnippet: "Inspect the Pantheon hook trace when debugging prompt/context/tool/provider orchestration behavior.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const snapshot = orchestration.getSnapshot();
      return { content: [{ type: "text", text: summarizeOrchestrationSnapshot(snapshot) }], details: snapshot };
    },
  });

  pi.registerTool({
    name: "pantheon_multiplexer_status",
    label: "Pantheon Multiplexer Status",
    description: "Inspect tmux/multiplexer state, active background panes, and project-scoped window naming.",
    promptSnippet: "Check multiplexer state before assuming a background task already has a live pane or shared window.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const taskDir = ensureDir(config.background?.logDir ?? path.join(process.cwd(), ".oh-my-opencode-pi-tasks"));
      const tasks = reconcileBackgroundTasks(taskDir, config.multiplexer);
      const text = renderMultiplexerStatus(ctx.cwd, config.multiplexer, tasks);
      return { content: [{ type: "text", text }], details: { windowName: getMultiplexerWindowName(ctx.cwd, config.multiplexer), tasks } };
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
      const { agentName, adapters, registered, loadErrors } = await getAllowedAdapters(ctx.cwd, config);
      const text = buildAdapterPolicyReport({ agentName, adapters, registered, loadErrors });
      return { content: [{ type: "text", text }], details: { agentName, allowed: adapters.map((adapter) => adapter.id), registered: registered.map((adapter) => adapter.id), loadErrors } };
    },
  });

  pi.registerTool({
    name: "pantheon_adapter_health",
    label: "Pantheon Adapter Health",
    description: "Inspect adapter auth status, readiness, and health hints before relying on a research source.",
    promptSnippet: "Check adapter health when source auth, readiness, or ranking confidence might affect research quality.",
    parameters: AdapterHealthParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const { adapters } = await getAllowedAdapters(ctx.cwd, config);
      const filtered = params.adapter ? adapters.filter((adapter) => adapter.id === params.adapter) : adapters;
      const results = await Promise.all(filtered.map(async (adapter) => ({ adapter, health: await healthCheckAdapter(ctx.cwd, config, adapter, signal) })));
      if (params.adapter && results.length === 0) {
        return { content: [{ type: "text", text: `No adapter found: ${params.adapter}` }], details: undefined, isError: true };
      }
      return {
        content: [{ type: "text", text: buildAdapterHealthLines(results) }],
        details: results.map((result) => ({ adapter: result.adapter.id, ...result.health })),
      };
    },
  });

  pi.registerTool({
    name: "pantheon_adapter_search",
    label: "Pantheon Adapter Search",
    description: "Search structured research sources through pluggable adapters such as docs-context7, npm-registry, grep-app, web-search, or github-releases.",
    promptSnippet: "Use the adapter layer when you need a structured docs/code/release source instead of an unscoped web fetch.",
    parameters: AdapterSearchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = loadPantheonConfig(ctx.cwd).config;
      const adapterIds = selectAdapterIds(config, params.adapter, params);
      const sections: Array<{ adapter: string; text: string; error?: string }> = [];
      const details: Array<{ adapter: string; details?: unknown; error?: string }> = [];
      for (const adapterId of adapterIds) {
        try {
          const adapter = await requireAdapter(ctx.cwd, config, adapterId);
          const result = await adapter.search(params, config, signal);
          sections.push({ adapter: adapter.id, text: result.text });
          details.push({ adapter: adapter.id, details: result.details });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sections.push({ adapter: adapterId, text: `Adapter error: ${message}`, error: message });
          details.push({ adapter: adapterId, error: message });
        }
      }
      const successful = details.filter((item) => !item.error).length;
      const text = [
        renderAdapterSelectionReport(config, params.adapter, params),
        summarizeAdapterSearchSections(sections),
        ...sections.map((section) => `## ${section.adapter}\n${section.text}`),
      ].join("\n\n") || "No adapter results.";
      return { content: [{ type: "text", text }], details: { adapters: details, selected: adapterIds, selection: renderAdapterSelectionReport(config, params.adapter, params) }, isError: successful === 0 };
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
        const adapter = await requireAdapter(ctx.cwd, config, params.adapter);
        const result = await adapter.fetch(params, config, signal);
        return { content: [{ type: "text", text: result.text }], details: { adapter: adapter.id, details: result.details } };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "pantheon_webfetch",
    label: "Pantheon Webfetch",
    description: "Fetch a URL with docs-aware extraction, llms.txt probing, and safe redirect handling.",
    promptSnippet: "Use smart webfetch for docs/static pages when you want llms.txt-aware extraction instead of a basic raw fetch.",
    parameters: WebfetchParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const config = loadPantheonConfig(ctx.cwd).config;
        const result = await smartFetch(params.url, {
          timeoutMs: config.research?.timeoutMs ?? 15000,
          userAgent: config.research?.userAgent ?? PANTHEON_USER_AGENT,
          signal,
          preferLlmsTxt: params.preferLlmsTxt === "always" || params.preferLlmsTxt === "never" ? params.preferLlmsTxt : "auto",
          extractMain: params.extractMain !== false,
          allowCrossOriginRedirects: params.allowCrossOriginRedirects === true,
          maxChars: Math.max(1000, Math.floor(params.maxChars ?? 12000)),
        });
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], details: { url: params.url, error: message }, isError: true };
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
      const text = await fetchText(params.url, config.research?.timeoutMs ?? 15000, config.research?.userAgent ?? PANTHEON_USER_AGENT, signal);
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
        config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
        config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
        config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
        config.research?.userAgent ?? PANTHEON_USER_AGENT,
        signal,
      );
      const results = params.topic?.trim()
        ? await webSearchResults(
            params.topic.trim(),
            config.research?.timeoutMs ?? 15000,
            config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
          config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
        config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
        config.research?.userAgent ?? PANTHEON_USER_AGENT,
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
  executePantheonDelegateCommand = async (params, signal, onUpdate, ctx) => {
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
        setSubagentActivityWidget(ctx, {
          title: "Pantheon subagents",
          subtitle: "delegate chain",
          entries: params.chain.map((step, index) => ({
            label: `${index + 1}. ${step.agent}`,
            result: {
              agent: step.agent,
              agentSource: "unknown",
              task: step.task,
              exitCode: -1,
              messages: [],
              stderr: "",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
              step: index + 1,
            },
          })),
        });

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
              const currentResults = [...results, current];
              setSubagentActivityWidget(ctx, {
                title: "Pantheon subagents",
                subtitle: "delegate chain",
                entries: currentResults.map((item, index) => ({ label: `${index + 1}. ${item.agent}`, result: item })),
              });
              onUpdate?.({
                content: partial.content,
                details: details("chain", currentResults),
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
        setSubagentActivityWidget(ctx, {
          title: "Pantheon subagents",
          subtitle: "delegate chain",
          entries: results.map((item, index) => ({ label: `${index + 1}. ${item.agent}`, result: item })),
        });
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

        setSubagentActivityWidget(ctx, {
          title: "Pantheon subagents",
          subtitle: `delegate parallel (${params.tasks.length})`,
          entries: runningResults.map((result) => ({ label: result.agent, result })),
        });

        const emitParallelUpdate = () => {
          const done = runningResults.filter((result) => result.exitCode !== -1).length;
          const running = runningResults.length - done;
          setSubagentActivityWidget(ctx, {
            title: "Pantheon subagents",
            subtitle: `delegate parallel (${done}/${runningResults.length} done)`,
            entries: runningResults.map((result) => ({ label: result.agent, result })),
          });
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
              startedAt: Date.now(),
              finishedAt: Date.now(),
              durationMs: 0,
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
        setSubagentActivityWidget(ctx, {
          title: "Pantheon subagents",
          subtitle: `delegate parallel (${successCount}/${results.length} ok)`,
          entries: results.map((result) => ({ label: result.agent, result })),
        });
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

      const initialSingleResult: SingleResult = {
        agent: agent.name,
        agentSource: agent.source,
        task: params.task!,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        startedAt: Date.now(),
      };
      setSubagentActivityWidget(ctx, {
        title: "Pantheon subagents",
        subtitle: "delegate single",
        entries: [{ label: agent.name, result: initialSingleResult }],
      });
      const result = await runSingleAgentWithFallback(ctx.cwd, agent.name, agent, params.task!, params.cwd, undefined, signal, (partial) => {
        const current = partial.details?.results?.[0] as SingleResult | undefined;
        if (current) {
          setSubagentActivityWidget(ctx, {
            title: "Pantheon subagents",
            subtitle: "delegate single",
            entries: [{ label: current.agent, result: current }],
          });
        }
        onUpdate?.({
          content: partial.content,
          details: details("single", current ? [current] : []),
        });
      }, undefined, debugTrace, `single-${agent.name}`);
      const isError = !isSuccessfulResult(result, { allowEmpty: config.fallback?.retryOnEmpty === false });
      updateDebugTraceSummary(debugTrace, { finishedAt: Date.now(), status: isError ? "error" : "completed", mode: "single", results: [result] });
      setSubagentActivityWidget(ctx, {
        title: "Pantheon subagents",
        subtitle: "delegate single",
        entries: [{ label: result.agent, result }],
      });
      const summaryText = result.abortReason
        ? `${summarizeResult(result)}\n\nAbort reason: ${result.abortReason}`
        : summarizeResult(result);
      return {
        content: [{ type: "text", text: summaryText }],
        details: details("single", [result]),
        isError,
      };
  };


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
      return executePantheonDelegateCommand!(params, signal, onUpdate, ctx);
    },
  });
  executePantheonCouncilCommand = async (params, signal, onUpdate, ctx) => {
      const config = loadPantheonConfig(ctx.cwd).config;
      const debugTrace = createDebugTrace(ctx.cwd, config, "pantheon_council", {
        params,
        cwd: ctx.cwd,
      });
      setSubagentActivityWidget(ctx, {
        title: "Pantheon subagents",
        subtitle: `council ${params.preset ?? "default"}`,
        entries: [],
      });
      try {
        const council = await runCouncil(
          ctx.cwd,
          params.includeProjectAgents ?? false,
          params.prompt,
          params.preset,
          signal,
          (partial) => {
            const partialCouncil = partial.details as { preset?: string; councillors?: Array<SingleResult & { memberName: string }> } | undefined;
            const current = partial.details && "results" in (partial.details as Record<string, unknown>)
              ? ((partial.details as { results?: SingleResult[] }).results?.[0])
              : undefined;
            if (partialCouncil?.councillors?.length) {
              setSubagentActivityWidget(ctx, {
                title: "Pantheon subagents",
                subtitle: `council ${params.preset ?? partialCouncil.preset ?? "default"} · member perspectives`,
                entries: partialCouncil.councillors.map((item) => ({ label: item.memberName, result: item })),
              });
            } else if (current) {
              setSubagentActivityWidget(ctx, {
                title: "Pantheon subagents",
                subtitle: `council ${params.preset ?? "default"} · synthesis`,
                entries: [{ label: "master", result: current }],
              });
            }
            onUpdate?.(partial);
          },
          debugTrace,
        );

        const footer = council.councillors.map((result) => `${result.memberName}: ${result.model ?? "default"}`).join(", ");
        setSubagentActivityWidget(ctx, {
          title: "Pantheon subagents",
          subtitle: `council ${params.preset ?? council.preset} · complete`,
          entries: [
            ...council.councillors.map((item) => ({ label: item.memberName, result: item })),
            { label: "master", result: council.master },
          ],
        });
        const abortLine = council.master.abortReason ? `\nAbort reason: ${council.master.abortReason}` : "";
        const displayedPreset = params.preset ?? council.preset;
        const text = `${summarizeResult(council.master)}${abortLine}\n\n---\nCouncil preset: ${displayedPreset}\nCouncil members: ${footer}`;
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
  };


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
      return executePantheonCouncilCommand!(params, signal, onUpdate, ctx);
    },
  });
}
