import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Box, Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { getBackgroundStatusCounts } from "./background.js";
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

export function getTaskStateChip(status: BackgroundTaskRecord["status"], theme: RenderTheme): string {
  if (status === "queued") return theme.fg("muted", "queued");
  if (status === "running") return theme.fg("warning", "running");
  if (status === "completed") return theme.fg("success", "done");
  if (status === "failed") return theme.fg("error", "failed");
  return theme.fg("warning", status);
}

function formatBackgroundTaskLine(task: BackgroundTaskRecord, theme: RenderTheme, maxPreview = 100): string {
  return `${getTaskStateChip(task.status, theme)} ${theme.fg("accent", task.agent)} ${theme.fg("dim", task.id)} ${theme.fg("muted", "—")} ${previewText(task.summary ?? task.task, maxPreview)}`;
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

export type CommandOutputStatus = "success" | "warning" | "error";

export interface PantheonCommandMessageDetails {
  command: string;
  body: string;
  status: CommandOutputStatus;
  summary?: string;
}

export function getCommandStatusColor(status: CommandOutputStatus): "success" | "warning" | "error" {
  return status === "success" ? "success" : status === "error" ? "error" : "warning";
}

export function getCommandStatusLabel(status: CommandOutputStatus): string {
  return status === "success" ? "✓ SUCCESS" : status === "error" ? "✖ ERROR" : "▲ WARNING";
}

export function buildPantheonStatusBanner(theme: RenderTheme, status: CommandOutputStatus, title: string): string {
  return theme.fg(getCommandStatusColor(status), theme.bold(`━━━ ${getCommandStatusLabel(status)} · ${title.toUpperCase()} ━━━`));
}

function firstMeaningfulLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "(no output)";
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
  const statusLabel = getCommandStatusLabel(status);
  const summary = details.summary?.trim();
  const maxPreview = Math.max(80, options?.maxPreview ?? 120);
  const output = details.body.trim() || "(no output)";
  const outputPreview = firstMeaningfulLine(output);
  const lines = [
    buildPantheonStatusBanner(theme, status, "Pantheon command output"),
    `${theme.fg("toolTitle", theme.bold(details.command))} ${theme.fg(statusColor, theme.bold(`• ${statusLabel}`))}`,
    summary ? theme.fg(statusColor, theme.bold(previewText(summary, maxPreview))) : theme.fg("accent", previewText(outputPreview, maxPreview)),
  ];
  if (options?.expanded) {
    lines.push("");
    lines.push(output);
  } else if (!summary || previewText(summary, maxPreview) !== previewText(outputPreview, maxPreview)) {
    lines.push(`${theme.fg("accent", theme.bold("Output preview:"))} ${theme.fg("accent", previewText(outputPreview, maxPreview))}`);
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
  const bold = ctx.ui?.theme?.bold?.bind(ctx.ui.theme) ?? ((value: string) => value);
  const counts = getBackgroundStatusCounts(tasks);
  const activeTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const maxTodos = Math.max(1, config.ui?.maxTodos ?? 3);
  const maxBackgroundTasks = Math.max(1, config.ui?.maxBackgroundTasks ?? 3);
  const lines: string[] = [];

  const chips = [
    themeAccent(ctx, "Pantheon"),
    counts.running > 0 ? fg("warning", `${counts.running} running`) : undefined,
    counts.queued > 0 ? fg("muted", `${counts.queued} queued`) : undefined,
    counts.stale > 0 ? fg("warning", `${counts.stale} stale`) : undefined,
    counts.failed + counts.cancelled > 0 ? fg("error", `${counts.failed + counts.cancelled} trouble`) : undefined,
    state.uncheckedTodos.length > 0 ? fg("accent", `${state.uncheckedTodos.length} todos`) : undefined,
    autoContinueEnabled ? fg("success", "auto on") : fg("dim", "auto off"),
    configWarnings > 0 ? fg("warning", `${configWarnings} warning${configWarnings === 1 ? "" : "s"}`) : undefined,
  ].filter((item): item is string => Boolean(item));
  if (chips.length > 0) lines.push(chips.join(fg("dim", " • ")));

  for (const task of activeTasks.slice(0, maxBackgroundTasks)) {
    lines.push(`${getTaskStateChip(task.status, { fg, bold })} ${fg("accent", task.agent)} ${fg("dim", task.id)} ${fg("muted", previewText(task.summary ?? task.task, 70))}`);
  }
  if (activeTasks.length > maxBackgroundTasks) {
    lines.push(fg("dim", `… +${activeTasks.length - maxBackgroundTasks} more active background task${activeTasks.length - maxBackgroundTasks === 1 ? "" : "s"}`));
  }

  for (const todo of state.uncheckedTodos.slice(0, maxTodos)) {
    lines.push(`${fg("muted", "☐")} ${previewText(todo, 96)}`);
  }
  if (state.uncheckedTodos.length > maxTodos) {
    lines.push(fg("dim", `… +${state.uncheckedTodos.length - maxTodos} more persisted todo${state.uncheckedTodos.length - maxTodos === 1 ? "" : "s"}`));
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
