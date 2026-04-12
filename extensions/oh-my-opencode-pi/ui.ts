import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
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
  return ctx.ui.theme.fg("accent", ctx.ui.theme.bold(text));
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

export function buildPantheonDashboardLines(
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
