import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildPantheonCommandOutputLines, formatPantheonCommandOutput, type CommandOutputStatus, type PantheonCommandMessageDetails } from "./ui.js";

export type PantheonPresentationMode = "notify" | "editor-report" | "widget-summary" | "chat-message";

export const DEFAULT_COMMAND_OUTPUT_WIDGET_KEY = "oh-my-opencode-pi-command-output";
export const PANTHEON_COMMAND_MESSAGE_TYPE = "pantheon-command-output";

export interface PantheonCommandPresentationOptions {
  status?: CommandOutputStatus;
  summary?: string;
  notifyMessage?: string;
  wrapEditor?: boolean;
  widgetKey?: string;
  modes?: PantheonPresentationMode[];
  dispatchMessage?: (message: { customType: string; content: string; display: boolean; details: PantheonCommandMessageDetails }) => void;
}

function inferDefaultModes(command: string, status: CommandOutputStatus): PantheonPresentationMode[] {
  if (status === "running") return ["widget-summary"];
  if (command === "/pantheon-council" || command === "/pantheon" || command === "/pantheon-as") {
    return status === "error"
      ? ["widget-summary", "chat-message", "editor-report", "notify"]
      : ["widget-summary", "chat-message", "editor-report"];
  }
  return status === "error" || status === "warning"
    ? ["widget-summary", "chat-message", "editor-report", "notify"]
    : ["widget-summary", "chat-message", "editor-report"];
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
  const modes = new Set(options?.modes ?? inferDefaultModes(command, status));
  const body = text.trim() || "(no output)";
  const details: PantheonCommandMessageDetails = { command, body, status, summary };
  const formatted = formatPantheonCommandOutput(command, body, { status, summary });

  if (modes.has("widget-summary") && ctx.ui.setWidget) {
    ctx.ui.setWidget(widgetKey, buildPantheonCommandOutputLines(ctx, command, body, { status, summary }), { placement: "belowEditor" });
  }
  if (modes.has("chat-message") && options?.dispatchMessage) {
    options.dispatchMessage({
      customType: PANTHEON_COMMAND_MESSAGE_TYPE,
      content: formatted,
      display: true,
      details,
    });
  }
  if (modes.has("editor-report")) {
    ctx.ui.setEditorText(options?.wrapEditor === false ? body : formatted);
  }
  if (modes.has("notify") && options?.notifyMessage) {
    ctx.ui.notify(
      options.notifyMessage,
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
    status: result.isError ? "error" : "running",
    summary,
    notifyMessage: undefined,
    modes: options?.modes ?? ["widget-summary"],
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
    notifyMessage: result.isError ? failureMessage : undefined,
  });
}
