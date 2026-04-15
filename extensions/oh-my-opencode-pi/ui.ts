import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Box, Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";
import { getBackgroundStatusCounts, isTaskStale } from "./background.js";
import type { PantheonConfig } from "./config.js";
import type { BackgroundTaskRecord } from "./types.js";
import type { WorkflowState } from "./workflow.js";

export type RenderTheme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;

function previewText(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function themeAccent(ctx: ExtensionContext, text: string): string {
  const fg = ctx.ui?.theme?.fg?.bind(ctx.ui.theme) ?? ((_color: string, value: string) => value);
  const bold = ctx.ui?.theme?.bold?.bind(ctx.ui.theme) ?? ((value: string) => value);
  return fg("accent", bold(text));
}

function taskStateLabel(task: BackgroundTaskRecord, staleAfterMs = 20000): string {
  return isTaskStale(task, staleAfterMs) ? `${task.status}/stale` : task.status;
}

function taskActionHint(task: BackgroundTaskRecord, staleAfterMs = 20000): string {
  if (task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs)) return `/pantheon-task-actions ${task.id}`;
  if (task.status === "running" || task.status === "queued") return `/pantheon-watch ${task.id}`;
  return `/pantheon-result ${task.id}`;
}

function formatTaskSummary(task: BackgroundTaskRecord, maxPreview = 90): string {
  return previewText(task.summary ?? task.task, maxPreview);
}

export function getTaskStateChip(status: BackgroundTaskRecord["status"], theme: RenderTheme): string {
  if (status === "queued") return theme.fg("muted", "queued");
  if (status === "running") return theme.fg("accent", "running");
  if (status === "completed") return theme.fg("success", "done");
  if (status === "failed") return theme.fg("error", "failed");
  if (status === "cancelled") return theme.fg("warning", "cancelled");
  return theme.fg("warning", status);
}

function formatBackgroundTaskLine(task: BackgroundTaskRecord, theme: RenderTheme, maxPreview = 100): string {
  return `${getTaskStateChip(task.status, theme)} ${theme.fg("accent", task.agent)} ${theme.fg("dim", task.id)} ${theme.fg("muted", "—")} ${formatTaskSummary(task, maxPreview)}`;
}

export function renderBackgroundToolCall(
  toolName: string,
  args: { agent?: string; task?: string; taskId?: string },
  theme: RenderTheme,
): Text {
  const body = args.taskId
    ? `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", args.taskId)}`
    : `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", args.agent || "task")}\n  ${theme.fg("muted", previewText(args.task || "", 90))}`;
  return new Text(body, 0, 0);
}

export function renderBackgroundToolResult(
  toolName: string,
  result: { content: Array<{ type: string; text?: string }>; details?: BackgroundTaskRecord | BackgroundTaskRecord[] },
  expanded: boolean,
  theme: RenderTheme,
): Text {
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

export function renderWorkflowToolResult(
  toolName: string,
  title: string,
  body: string,
  theme: RenderTheme,
): Text {
  return new Text(`${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", title)}\n${body}`, 0, 0);
}

export type CommandOutputStatus = "success" | "warning" | "error" | "running";

export interface PantheonCommandMessageDetails {
  command: string;
  body: string;
  status: CommandOutputStatus;
  summary?: string;
}

export function getCommandStatusColor(status: CommandOutputStatus): "success" | "warning" | "error" | "accent" {
  if (status === "success") return "success";
  if (status === "error") return "error";
  if (status === "running") return "accent";
  return "warning";
}

export function getCommandStatusLabel(status: CommandOutputStatus): string {
  if (status === "success") return "✓ ready";
  if (status === "error") return "✖ failed";
  if (status === "running") return "… running";
  return "! attention";
}

export function buildPantheonStatusBanner(theme: RenderTheme, status: CommandOutputStatus, title: string): string {
  return `${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(getCommandStatusColor(status), theme.bold(getCommandStatusLabel(status)))}`;
}

function firstMeaningfulLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "(no output)";
}

function extractMeaningfulPreview(text: string): string {
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) return "(no output)";
  const first = candidates[0];
  if (/^pantheon\b.+\breport$/i.test(first) && candidates[1]) return candidates[1];
  if (/^(output|summary|result|details):$/i.test(first) && candidates[1]) return candidates[1];
  return first;
}

function looksGenericSummary(summary: string): boolean {
  return /\b(report|overview|context|state|trace)\b/i.test(summary) && !/\b(error|warning|failed|passed|ready|running|queued|stale|update|todo|result|found|loaded|retry|cancelled|completed|council|delegate)\b/i.test(summary);
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function choosePrimarySummary(summary: string | undefined, preview: string): string {
  const cleanSummary = summary?.trim();
  if (!cleanSummary) return preview;
  if (looksGenericSummary(cleanSummary) && normalized(cleanSummary) !== normalized(preview)) return preview;
  return cleanSummary;
}

export function formatPantheonCommandOutput(
  command: string,
  body: string,
  options?: { status?: CommandOutputStatus; summary?: string },
): string {
  const status = options?.status ?? "success";
  const summary = options?.summary?.trim();
  const output = body.trim() || "(no output)";
  return [
    "Pantheon command output",
    `Command: ${command}`,
    `Status: ${status}`,
    summary ? `Summary: ${summary}` : undefined,
    "",
    "Output:",
    output,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function buildPantheonCommandOutputLines(
  ctx: ExtensionContext,
  command: string,
  body: string,
  options?: { status?: CommandOutputStatus; summary?: string },
): string[] {
  const fg = ctx.ui?.theme?.fg?.bind(ctx.ui.theme) ?? ((_color: string, text: string) => text);
  const bold = ctx.ui?.theme?.bold?.bind(ctx.ui.theme) ?? ((text: string) => text);
  return buildPantheonCommandMessageLines({ fg, bold }, { command, body, status: options?.status ?? "success", summary: options?.summary });
}

export function buildPantheonCommandMessageLines(
  theme: RenderTheme,
  details: PantheonCommandMessageDetails,
  options?: { expanded?: boolean; maxPreview?: number },
): string[] {
  const status = details.status ?? "success";
  const statusColor = getCommandStatusColor(status);
  const maxPreview = Math.max(80, options?.maxPreview ?? 120);
  const output = details.body.trim() || "(no output)";
  const outputPreview = extractMeaningfulPreview(output);
  const primarySummary = choosePrimarySummary(details.summary, outputPreview);
  const lines = [
    `${theme.fg("toolTitle", theme.bold(details.command))} ${theme.fg(statusColor, theme.bold(getCommandStatusLabel(status)))}`,
    theme.fg(statusColor, theme.bold(previewText(primarySummary, maxPreview))),
  ];
  if (!options?.expanded && normalized(primarySummary) !== normalized(outputPreview)) {
    lines.push(`${theme.fg("dim", "detail:")} ${theme.fg("accent", previewText(outputPreview, maxPreview))}`);
  }
  if (options?.expanded) {
    lines.push("");
    lines.push(output);
  }
  return lines;
}

export function renderPantheonCommandMessage(
  details: PantheonCommandMessageDetails,
  expanded: boolean,
  theme: RenderTheme & { bg: (color: string, text: string) => string },
): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(buildPantheonCommandMessageLines(theme, details, { expanded, maxPreview: expanded ? 160 : 120 }).join("\n"), 0, 0));
  return box;
}

export function buildPantheonDashboardLines(
  ctx: ExtensionContext,
  config: PantheonConfig,
  state: WorkflowState,
  tasks: BackgroundTaskRecord[],
  autoContinueEnabled: boolean,
  configWarnings: number,
): string[] {
  const fg = ctx.ui?.theme?.fg?.bind(ctx.ui.theme) ?? ((_color: string, value: string) => value);
  const counts = getBackgroundStatusCounts(tasks);
  const staleAfterMs = config.background?.staleAfterMs ?? 20000;
  const activeTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const attentionTask = tasks.find((task) => task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs));
  const focusTask = attentionTask ?? activeTasks[0];

  const countsLine = [
    counts.failed > 0 ? fg("error", `failed: ${counts.failed}`) : undefined,
    counts.cancelled > 0 ? fg("warning", `cancelled: ${counts.cancelled}`) : undefined,
    counts.stale > 0 ? fg("warning", `stale: ${counts.stale}`) : undefined,
    counts.running > 0 ? fg("accent", `running: ${counts.running}`) : undefined,
    counts.queued > 0 ? fg("muted", `queued: ${counts.queued}`) : undefined,
    state.uncheckedTodos.length > 0 ? fg("accent", `todos: ${state.uncheckedTodos.length}`) : undefined,
    configWarnings > 0 ? fg("warning", `warnings: ${configWarnings}`) : undefined,
    fg(autoContinueEnabled ? "success" : "dim", `auto: ${autoContinueEnabled ? "on" : "off"}`),
  ].filter((item): item is string => Boolean(item));

  if (!focusTask && state.uncheckedTodos.length === 0 && configWarnings === 0) {
    return [
      `${themeAccent(ctx, "Pantheon")} ${fg("success", "• ready")}`,
      fg("muted", "No active background work or carried-over todos."),
      `${fg("dim", "next:")} ${fg("accent", "/pantheon")}`,
    ];
  }

  const header = attentionTask
    ? `${themeAccent(ctx, "Pantheon")} ${fg("error", "• attention needed")}`
    : activeTasks.length > 0
      ? `${themeAccent(ctx, "Pantheon")} ${fg("accent", "• work in flight")}`
      : `${themeAccent(ctx, "Pantheon")} ${fg("warning", "• follow-up available")}`;

  const lines: string[] = [header];
  if (countsLine.length > 0) lines.push(countsLine.join(fg("dim", " • ")));

  if (focusTask) {
    const focusState = taskStateLabel(focusTask, staleAfterMs);
    const actionLabel = attentionTask ? "attention" : "now";
    lines.push(`${fg(attentionTask ? "error" : "accent", `${actionLabel}:`)} ${fg("dim", `${focusTask.id} ${focusTask.agent} [${focusState}]`)} ${fg("muted", "—")} ${formatTaskSummary(focusTask, 78)}`);
    lines.push(`${fg("dim", "next:")} ${fg("accent", taskActionHint(focusTask, staleAfterMs))}`);
  } else if (state.uncheckedTodos.length > 0) {
    lines.push(`${fg("accent", "now:")} ${previewText(state.uncheckedTodos[0] ?? "", 88)}`);
    lines.push(`${fg("dim", "next:")} ${fg("accent", "/pantheon-resume")}`);
  } else if (configWarnings > 0) {
    lines.push(`${fg("warning", "now:")} Review Pantheon config warnings and active presets.`);
    lines.push(`${fg("dim", "next:")} ${fg("accent", "/pantheon-config")}`);
  }

  return lines;
}

export interface PantheonSidebarSnapshot {
  config: PantheonConfig;
  state: WorkflowState;
  tasks: BackgroundTaskRecord[];
  autoContinueEnabled: boolean;
  configWarnings: number;
}

export interface PantheonSidebarAction {
  action: "overview" | "launcher" | "task-actions";
  taskId?: string;
}

function getPantheonSidebarFocusTask(snapshot: PantheonSidebarSnapshot): BackgroundTaskRecord | undefined {
  const staleAfterMs = snapshot.config.background?.staleAfterMs ?? 20000;
  const attentionTask = snapshot.tasks.find((task) => task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs));
  if (attentionTask) return attentionTask;
  return snapshot.tasks.find((task) => task.status === "queued" || task.status === "running") ?? snapshot.tasks[0];
}

function rankPantheonSidebarTask(task: BackgroundTaskRecord, staleAfterMs: number): number {
  if (task.status === "failed" || task.status === "cancelled" || isTaskStale(task, staleAfterMs)) return 0;
  if (task.status === "running" || task.status === "queued") return 1;
  return 2;
}

export function buildPantheonSidebarLines(
  theme: { fg: RenderTheme["fg"]; bold: RenderTheme["bold"]; bg: (color: any, text: string) => string },
  snapshot: PantheonSidebarSnapshot,
): string[] {
  const { config, state, tasks, autoContinueEnabled, configWarnings } = snapshot;
  const staleAfterMs = config.background?.staleAfterMs ?? 20000;
  const counts = getBackgroundStatusCounts(tasks, staleAfterMs);
  const focusTask = getPantheonSidebarFocusTask(snapshot);
  const maxTodos = Math.max(1, config.ui?.maxTodos ?? 3);
  const maxTasks = Math.max(1, config.ui?.maxBackgroundTasks ?? 3);
  const visibleTasks = [...tasks]
    .sort((a, b) => rankPantheonSidebarTask(a, staleAfterMs) - rankPantheonSidebarTask(b, staleAfterMs) || b.createdAt - a.createdAt)
    .slice(0, maxTasks);

  const countsLine = [
    counts.failed > 0 ? theme.fg("error", `failed ${counts.failed}`) : undefined,
    counts.cancelled > 0 ? theme.fg("warning", `cancelled ${counts.cancelled}`) : undefined,
    counts.stale > 0 ? theme.fg("warning", `stale ${counts.stale}`) : undefined,
    counts.running > 0 ? theme.fg("accent", `running ${counts.running}`) : undefined,
    counts.queued > 0 ? theme.fg("muted", `queued ${counts.queued}`) : undefined,
    state.uncheckedTodos.length > 0 ? theme.fg("accent", `todos ${state.uncheckedTodos.length}`) : undefined,
    configWarnings > 0 ? theme.fg("warning", `warnings ${configWarnings}`) : undefined,
    theme.fg(autoContinueEnabled ? "success" : "dim", `auto ${autoContinueEnabled ? "on" : "off"}`),
  ].filter((item): item is string => Boolean(item));

  const lines: string[] = [
    theme.bg("selectedBg", theme.fg("text", ` ${theme.bold("Pantheon")} · sidebar prototype `)),
    theme.fg("warning", theme.bold("Overlay demo — not a native docked sidebar")),
  ];
  if (countsLine.length > 0) lines.push(countsLine.join(theme.fg("dim", " • ")));

  if (!focusTask && state.uncheckedTodos.length === 0 && configWarnings === 0) {
    lines.push("");
    lines.push(theme.fg("success", "Ready — no active background work or carried-over todos."));
  } else if (focusTask) {
    const focusState = taskStateLabel(focusTask, staleAfterMs);
    const focusColor = focusTask.status === "failed" || focusTask.status === "cancelled" || isTaskStale(focusTask, staleAfterMs) ? "error" : "accent";
    lines.push("");
    lines.push(theme.fg(focusColor, theme.bold("Focus")));
    lines.push(`${theme.fg("dim", `${focusTask.id} ${focusTask.agent} [${focusState}]`)} ${theme.fg("muted", "—")} ${formatTaskSummary(focusTask, 72)}`);
    lines.push(`${theme.fg("dim", "next:")} ${theme.fg("accent", taskActionHint(focusTask, staleAfterMs))}`);
  } else if (state.uncheckedTodos.length > 0) {
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Focus")));
    lines.push(previewText(state.uncheckedTodos[0] ?? "", 88));
    lines.push(`${theme.fg("dim", "next:")} ${theme.fg("accent", "/pantheon-resume")}`);
  } else if (configWarnings > 0) {
    lines.push("");
    lines.push(theme.fg("warning", theme.bold("Focus")));
    lines.push("Review Pantheon config warnings and active presets.");
    lines.push(`${theme.fg("dim", "next:")} ${theme.fg("accent", "/pantheon-config")}`);
  }

  if (visibleTasks.length > 0) {
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Tasks")));
    for (const task of visibleTasks) {
      lines.push(`• ${formatBackgroundTaskLine(task, theme, 64)}`);
    }
    if (tasks.length > visibleTasks.length) {
      lines.push(theme.fg("dim", `… +${tasks.length - visibleTasks.length} more task${tasks.length - visibleTasks.length === 1 ? "" : "s"}`));
    }
  }

  if (state.uncheckedTodos.length > 0) {
    lines.push("");
    lines.push(theme.fg("accent", theme.bold("Todos")));
    for (const todo of state.uncheckedTodos.slice(0, maxTodos)) {
      lines.push(`${theme.fg("dim", "○")} ${previewText(todo, 78)}`);
    }
    if (state.uncheckedTodos.length > maxTodos) {
      lines.push(theme.fg("dim", `… +${state.uncheckedTodos.length - maxTodos} more todo${state.uncheckedTodos.length - maxTodos === 1 ? "" : "s"}`));
    }
  }

  lines.push("");
  lines.push(theme.fg("accent", theme.bold("Keys")));
  lines.push(`${theme.fg("accent", "o")} overview report`);
  lines.push(`${theme.fg("accent", "p")} Pantheon launcher`);
  if (focusTask) lines.push(`${theme.fg("accent", "t")} task actions for ${focusTask.id}`);
  lines.push(`${theme.fg("accent", "r")} refresh`);
  lines.push(`${theme.fg("accent", "q / Esc")} close`);

  return lines;
}

export async function showPantheonSidebar(
  ctx: ExtensionContext,
  getSnapshot: () => PantheonSidebarSnapshot,
): Promise<PantheonSidebarAction | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<PantheonSidebarAction | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const panel = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const bodyText = new Text("", 0, 0);
    let refreshInterval: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const close = (value: PantheonSidebarAction | null) => {
      if (closed) return;
      closed = true;
      if (refreshInterval) clearInterval(refreshInterval);
      done(value);
    };

    refreshInterval = setInterval(() => {
      if (!closed) tui.requestRender();
    }, 1500);

    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    panel.addChild(bodyText);
    container.addChild(panel);
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render(width: number) {
        bodyText.setText(buildPantheonSidebarLines(theme, getSnapshot()).join("\n"));
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        const snapshot = getSnapshot();
        const focusTask = getPantheonSidebarFocusTask(snapshot);
        if (matchesKey(data, "escape") || data === "q") {
          close(null);
          return;
        }
        if (data === "r") {
          tui.requestRender();
          return;
        }
        if (data === "o") {
          close({ action: "overview" });
          return;
        }
        if (data === "p") {
          close({ action: "launcher" });
          return;
        }
        if (data === "t" && focusTask) {
          close({ action: "task-actions", taskId: focusTask.id });
        }
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "right-center",
      width: "32%",
      minWidth: 38,
      maxHeight: "86%",
      margin: { top: 1, right: 1, bottom: 1, left: 0 },
    },
  });
}

export function buildPantheonSelectChromeLines(
  theme: { fg: RenderTheme["fg"]; bold: RenderTheme["bold"]; bg: (color: any, text: string) => string },
  title: string,
  hint: string,
): string[] {
  return [
    theme.bg("selectedBg", theme.fg("text", ` ${theme.bold("Pantheon")} · ${title} `)),
    theme.fg("warning", theme.bold("Interactive selector active")),
    theme.fg("dim", "The workspace is paused until you choose an option or cancel."),
    theme.bg("toolPendingBg", theme.fg("text", ` ${hint} `)),
  ];
}

export function buildPantheonReportModalLines(
  theme: { fg: RenderTheme["fg"]; bold: RenderTheme["bold"]; bg: (color: any, text: string) => string },
  title: string,
  summary: string,
  body: string,
  hint = "↑↓ / j k / Home End scroll • Enter or Esc close • Full report stays in the editor.",
  startLine = 0,
  maxBodyLines = 18,
): string[] {
  const bodyLines = body.trim().split(/\r?\n/);
  const clampedStart = Math.max(0, Math.min(startLine, Math.max(0, bodyLines.length - 1)));
  const visible = bodyLines.slice(clampedStart, clampedStart + maxBodyLines).map((line) => line.length > 0 ? line : " ");
  const endLine = Math.min(bodyLines.length, clampedStart + visible.length);
  const hiddenAbove = clampedStart;
  const hiddenBelow = Math.max(0, bodyLines.length - endLine);
  const scrollSummary = bodyLines.length > maxBodyLines
    ? `Showing lines ${clampedStart + 1}-${endLine} of ${bodyLines.length}`
    : `Showing all ${bodyLines.length} line${bodyLines.length === 1 ? "" : "s"}`;
  return [
    theme.bg("selectedBg", theme.fg("text", ` ${theme.bold("Pantheon")} · ${title} `)),
    theme.fg("accent", theme.bold(summary.trim() || "Report")),
    theme.fg("dim", "Local modal view active. The full report is also loaded in the editor."),
    theme.fg("dim", scrollSummary),
    ...(hiddenAbove > 0 ? [theme.fg("dim", `↑ ${hiddenAbove} earlier line${hiddenAbove === 1 ? "" : "s"}`)] : []),
    "",
    ...visible,
    ...(hiddenBelow > 0 ? [theme.fg("dim", `↓ ${hiddenBelow} more line${hiddenBelow === 1 ? "" : "s"}`)] : []),
    "",
    theme.bg("toolPendingBg", theme.fg("text", ` ${hint} `)),
  ];
}

export async function showPantheonReportModal(
  ctx: ExtensionContext,
  title: string,
  summary: string,
  body: string,
  hint = "↑↓ / j k / Home End scroll • Enter or Esc close • Full report stays in the editor.",
): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const container = new Container();
    const panel = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const bodyText = new Text("", 0, 0);
    const bodyLines = body.trim().split(/\r?\n/);
    const maxBodyLines = 18;
    let startLine = 0;
    const maxStartLine = Math.max(0, bodyLines.length - maxBodyLines);

    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    panel.addChild(bodyText);
    container.addChild(panel);
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render(width: number) {
        bodyText.setText(buildPantheonReportModalLines(theme, title, summary, body, hint, startLine, maxBodyLines).join("\n"));
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "space")) {
          done();
          return;
        }
        if (matchesKey(data, "up") || data === "k") {
          startLine = Math.max(0, startLine - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "down") || data === "j") {
          startLine = Math.min(maxStartLine, startLine + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "home")) {
          startLine = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "end")) {
          startLine = maxStartLine;
          tui.requestRender();
        }
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "74%",
      minWidth: 60,
      maxHeight: "78%",
      margin: 2,
    },
  });
}

export interface PantheonSubagentInspectorEntry {
  label: string;
  description: string;
  expandedLines: string[];
  traceAvailable?: boolean;
}

export interface PantheonSubagentInspectorSnapshot {
  title: string;
  subtitle?: string;
  entries: PantheonSubagentInspectorEntry[];
}

export interface PantheonSubagentInspectorAction {
  action: "details" | "summary" | "stdout" | "stderr" | "paths" | "trace";
  index: number;
}

export function buildPantheonSubagentInspectorLines(
  theme: { fg: RenderTheme["fg"]; bold: RenderTheme["bold"]; bg: (color: any, text: string) => string },
  snapshot: PantheonSubagentInspectorSnapshot,
  expandedEntries: Iterable<number>,
  selectedIndex: number,
  hint = "↑↓ / Home End move • Enter or Space expand/collapse • o details • s summary • l output • e stderr • p paths • t trace • Esc close",
  maxBodyLines = 18,
): string[] {
  const expandedSet = new Set(expandedEntries);
  const bodyLines: string[] = [];
  const headerLineIndexes: number[] = [];

  snapshot.entries.forEach((entry, index) => {
    headerLineIndexes[index] = bodyLines.length;
    const marker = expandedSet.has(index) ? "▼" : "▶";
    const header = `${marker} ${entry.label} — ${previewText(entry.description, 104)}`;
    bodyLines.push(
      index === selectedIndex
        ? theme.bg("selectedBg", theme.fg("text", ` ${header} `))
        : `${theme.fg("accent", `${marker} ${entry.label}`)} ${theme.fg("muted", "—")} ${theme.fg("muted", previewText(entry.description, 104))}`,
    );
    if (expandedSet.has(index)) {
      const detailLines = entry.expandedLines.length > 0 ? entry.expandedLines : ["(no live detail available)"];
      for (const line of detailLines) bodyLines.push(`  ${line}`);
    }
  });

  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, snapshot.entries.length - 1)));
  const selectedLine = headerLineIndexes[safeSelectedIndex] ?? 0;
  const totalBodyLines = bodyLines.length;
  const visibleCount = Math.max(8, maxBodyLines);
  const maxStartLine = Math.max(0, totalBodyLines - visibleCount);
  const startLine = Math.max(0, Math.min(maxStartLine, selectedLine - Math.floor(visibleCount / 3)));
  const visible = bodyLines.slice(startLine, startLine + visibleCount);
  const endLine = Math.min(totalBodyLines, startLine + visible.length);
  const hiddenAbove = startLine;
  const hiddenBelow = Math.max(0, totalBodyLines - endLine);
  const scrollSummary = totalBodyLines > visibleCount
    ? `Showing lines ${startLine + 1}-${endLine} of ${totalBodyLines}`
    : `Showing all ${totalBodyLines} line${totalBodyLines === 1 ? "" : "s"}`;
  const expandedCount = Array.from(expandedSet).filter((index) => index >= 0 && index < snapshot.entries.length).length;
  const selected = snapshot.entries[safeSelectedIndex];
  const inspectorSummary = `${snapshot.entries.length} subagent${snapshot.entries.length === 1 ? "" : "s"} • ${expandedCount} expanded${selected ? ` • selected ${selected.label}` : ""}`;

  return [
    theme.bg("selectedBg", theme.fg("text", ` ${theme.bold("Pantheon")} · ${snapshot.title} `)),
    theme.fg("accent", theme.bold(snapshot.subtitle?.trim() || inspectorSummary)),
    theme.fg("dim", "Live subagent inspector. The view refreshes while delegate/council work is still running."),
    theme.fg("dim", scrollSummary),
    ...(hiddenAbove > 0 ? [theme.fg("dim", `↑ ${hiddenAbove} earlier line${hiddenAbove === 1 ? "" : "s"}`)] : []),
    "",
    ...visible,
    ...(hiddenBelow > 0 ? [theme.fg("dim", `↓ ${hiddenBelow} more line${hiddenBelow === 1 ? "" : "s"}`)] : []),
    "",
    theme.bg("toolPendingBg", theme.fg("text", ` ${hint} `)),
  ];
}

export async function showPantheonSubagentInspector(
  ctx: ExtensionContext,
  getSnapshot: () => PantheonSubagentInspectorSnapshot | undefined,
  hint = "↑↓ / Home End move • Enter or Space expand/collapse • o details • s summary • l output • e stderr • p paths • t trace • Esc close",
): Promise<PantheonSubagentInspectorAction | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<PantheonSubagentInspectorAction | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const panel = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const bodyText = new Text("", 0, 0);
    let selectedIndex = 0;
    const expandedEntries = new Set<number>();
    let refreshInterval: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    const close = (value: PantheonSubagentInspectorAction | null) => {
      if (closed) return;
      closed = true;
      if (refreshInterval) clearInterval(refreshInterval);
      done(value);
    };

    const currentSnapshot = () => getSnapshot() ?? { title: "Pantheon subagents", entries: [] };
    refreshInterval = setInterval(() => {
      if (!closed) tui.requestRender();
    }, 500);

    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    panel.addChild(bodyText);
    container.addChild(panel);
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render(width: number) {
        const snapshot = currentSnapshot();
        selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, snapshot.entries.length - 1)));
        bodyText.setText(buildPantheonSubagentInspectorLines(theme, snapshot, expandedEntries, selectedIndex, hint).join("\n"));
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        const snapshot = currentSnapshot();
        if (matchesKey(data, "escape") || data === "q") {
          close(null);
          return;
        }
        if (snapshot.entries.length === 0) {
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "up") || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "down") || data === "j") {
          selectedIndex = Math.min(snapshot.entries.length - 1, selectedIndex + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "home")) {
          selectedIndex = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "end")) {
          selectedIndex = Math.max(0, snapshot.entries.length - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "return") || matchesKey(data, "space")) {
          if (expandedEntries.has(selectedIndex)) expandedEntries.delete(selectedIndex);
          else expandedEntries.add(selectedIndex);
          tui.requestRender();
          return;
        }
        if (data === "o") return close({ action: "details", index: selectedIndex });
        if (data === "s") return close({ action: "summary", index: selectedIndex });
        if (data === "l") return close({ action: "stdout", index: selectedIndex });
        if (data === "e") return close({ action: "stderr", index: selectedIndex });
        if (data === "p") return close({ action: "paths", index: selectedIndex });
        if (data === "t" && snapshot.entries[selectedIndex]?.traceAvailable) return close({ action: "trace", index: selectedIndex });
      },
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "78%",
      minWidth: 64,
      maxHeight: "82%",
      margin: 2,
    },
  });
}

export async function showPantheonSelect(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  hint = "↑↓ navigate • enter select • esc cancel",
): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const [titleLine, statusLine, contextLine, hintLine] = buildPantheonSelectChromeLines(theme, title, hint);
    const container = new Container();
    const panel = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    panel.addChild(new Text(titleLine, 0, 0));
    panel.addChild(new Text(statusLine, 0, 0));
    panel.addChild(new Text(contextLine, 0, 0));
    panel.addChild(new Spacer(1));

    const selectList = new SelectList(items, Math.min(Math.max(items.length, 3), 12), {
      selectedPrefix: (text) => theme.bg("selectedBg", theme.fg("text", text)),
      selectedText: (text) => theme.bg("selectedBg", theme.fg("text", text)),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(String(item.value));
    selectList.onCancel = () => done(null);
    panel.addChild(selectList);
    panel.addChild(new Spacer(1));
    panel.addChild(new Text(hintLine, 0, 0));
    container.addChild(panel);
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
      anchor: "center",
      width: "68%",
      minWidth: 58,
      maxHeight: "72%",
      margin: 2,
    },
  });
}
