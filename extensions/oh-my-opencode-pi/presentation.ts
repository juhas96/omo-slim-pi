import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildPantheonCommandOutputLines, formatPantheonCommandOutput, type CommandOutputStatus } from "./ui.js";

export type PantheonPresentationMode = "notify" | "editor-report" | "widget-summary";

export const DEFAULT_COMMAND_OUTPUT_WIDGET_KEY = "oh-my-opencode-pi-command-output";

export interface PantheonCommandPresentationOptions {
  status?: CommandOutputStatus;
  summary?: string;
  notifyMessage?: string;
  wrapEditor?: boolean;
  widgetKey?: string;
  modes?: PantheonPresentationMode[];
}

export function presentPantheonCommandEditorOutput(
  command: string,
  text: string,
  ctx: ExtensionContext,
  options?: PantheonCommandPresentationOptions,
): void {
  const status = options?.status ?? "success";
  const summary = options?.summary?.trim();
  const widgetKey = options?.widgetKey ?? DEFAULT_COMMAND_OUTPUT_WIDGET_KEY;
  const modes = new Set(options?.modes ?? ["widget-summary", "editor-report", "notify"]);

  if (modes.has("widget-summary") && ctx.ui.setWidget) {
    ctx.ui.setWidget(widgetKey, buildPantheonCommandOutputLines(ctx, command, text, { status, summary }), { placement: "belowEditor" });
  }
  if (modes.has("editor-report")) {
    ctx.ui.setEditorText(options?.wrapEditor === false ? text : formatPantheonCommandOutput(command, text, { status, summary }));
  }
  if (modes.has("notify")) {
    ctx.ui.notify(
      options?.notifyMessage ?? `Loaded ${command} output into editor.`,
      status === "error" ? "error" : status === "warning" ? "warning" : "info",
    );
  }
}

export function extractPantheonResultText(result: AgentToolResult<any> & { isError?: boolean }): string {
  return result.content?.[0]?.type === "text" ? result.content[0].text ?? "(no output)" : "(no output)";
}

export function presentPantheonCommandProgress(
  command: string,
  result: AgentToolResult<any> & { isError?: boolean },
  ctx: ExtensionContext,
  summary: string,
  options?: Omit<PantheonCommandPresentationOptions, "status" | "summary" | "notifyMessage">,
): void {
  presentPantheonCommandEditorOutput(command, extractPantheonResultText(result), ctx, {
    ...options,
    status: result.isError ? "error" : "warning",
    summary,
    notifyMessage: undefined,
    modes: options?.modes ?? ["widget-summary", "editor-report"],
  });
}

export function presentPantheonCommandResult(
  command: string,
  result: AgentToolResult<any> & { isError?: boolean },
  ctx: ExtensionContext,
  successMessage: string,
  failureMessage: string,
  options?: Omit<PantheonCommandPresentationOptions, "status" | "summary" | "notifyMessage">,
): void {
  presentPantheonCommandEditorOutput(command, extractPantheonResultText(result), ctx, {
    ...options,
    status: result.isError ? "error" : "success",
    summary: result.isError ? failureMessage : successMessage,
    notifyMessage: result.isError ? failureMessage : successMessage,
  });
}
