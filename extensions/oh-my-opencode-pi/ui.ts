import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Box, Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
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

export async function showPantheonSelect(
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
