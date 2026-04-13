import type { PantheonConfigDiagnostic, PantheonConfigLoadResult } from "./config.js";

function formatList(items: string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}

function formatBoolean(value: boolean | undefined, whenTrue = "enabled", whenFalse = "disabled"): string {
  return value === false ? whenFalse : whenTrue;
}

function formatDiagnostic(diag: PantheonConfigDiagnostic): string {
  return `- [${diag.severity}] ${diag.path}${diag.source ? ` (${diag.source})` : ""} — ${diag.message}`;
}

export function buildConfigReport(result: PantheonConfigLoadResult): string {
  const config = result.config;
  const agents = Object.keys(config.agents ?? {});
  const councilPresets = Object.keys(config.council?.presets ?? {});
  return [
    "Pantheon config report",
    "",
    "Sources:",
    `- Global config: ${result.sources.globalPath}`,
    `- Project config: ${result.sources.projectPath ?? "(none)"}`,
    "",
    "Presets:",
    `- Active presets: ${formatList(result.activePresets)}`,
    `- Available presets: ${formatList(result.availablePresets)}`,
    `- Council presets: ${formatList(councilPresets.length > 0 ? councilPresets : ["default", "quick", "balanced", "review-board"])}`,
    "",
    "Workflow & UI:",
    `- Extension: ${formatBoolean(config.enabled)}`,
    `- Dashboard widget: ${formatBoolean(config.ui?.dashboardWidget)}`,
    `- Workflow hints: ${formatBoolean(config.workflow?.injectHints)}`,
    `- Persist todos: ${formatBoolean(config.workflow?.persistTodos)}`,
    `- Auto-continue: ${config.autoContinue?.enabled ? "enabled" : "disabled"}`,
    `- Max continuations: ${config.autoContinue?.maxContinuations ?? 5}`,
    "",
    "Background & multiplexer:",
    `- Background tasks: ${formatBoolean(config.background?.enabled)}`,
    `- Max concurrent: ${config.background?.maxConcurrent ?? 1}`,
    `- Reuse sessions: ${config.background?.reuseSessions === false ? "disabled" : "enabled"}`,
    `- Heartbeat interval: ${config.background?.heartbeatIntervalMs ?? 1500}ms`,
    `- Stale after: ${config.background?.staleAfterMs ?? 20000}ms`,
    `- tmux integration: ${config.multiplexer?.tmux ? "enabled" : "disabled"}`,
    `- Project-scoped window: ${config.multiplexer?.projectScopedWindow === false ? "disabled" : "enabled"}`,
    "",
    "Skills & adapters:",
    `- Default skill allow: ${formatList(config.skills?.defaultAllow)}`,
    `- Default skill deny: ${formatList(config.skills?.defaultDeny)}`,
    `- Cartography: ${config.skills?.cartography?.enabled === false ? "disabled" : "enabled"}`,
    `- Adapter default allow: ${formatList(config.adapters?.defaultAllow)}`,
    `- Adapter default deny: ${formatList(config.adapters?.defaultDeny)}`,
    `- Disabled adapters: ${formatList(config.adapters?.disabled)}`,
    "",
    "Agents:",
    ...(agents.length > 0 ? agents.map((agent) => `- ${agent}`) : ["- (none)"]),
    ...(result.diagnostics.length > 0 ? ["", "Diagnostics:", ...result.diagnostics.map(formatDiagnostic)] : []),
    ...(result.warnings.length > 0 ? ["", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`)] : []),
    "",
    "Suggested next steps:",
    "- Use /pantheon-adapters to inspect the effective adapter allowlist for the current session.",
    "- Use /pantheon-adapter-health before relying on external research sources.",
    "- Use /pantheon-hooks or /pantheon-doctor when behavior does not match expectations.",
  ].filter((line): line is string => typeof line === "string").join("\n") + "\n";
}

export function buildDoctorReport(args: {
  cwd: string;
  config: PantheonConfigLoadResult;
  adapterHealth: Array<{ id: string; status: string; auth?: string; summary: string }>;
  tmuxAvailable: boolean;
  inTmux: boolean;
  backgroundDir: string;
  backgroundDirExists: boolean;
  debugDir: string;
  debugDirExists: boolean;
  workflowStatePath: string;
  workflowStateExists: boolean;
  taskCount: number;
}): string {
  const errors = args.config.diagnostics.filter((item) => item.severity === "error");
  const warnings = args.config.diagnostics.filter((item) => item.severity === "warning");
  const unhealthyAdapters = args.adapterHealth.filter((item) => item.status !== "ok");
  return [
    "Pantheon doctor report",
    "",
    `Workspace: ${args.cwd}`,
    `Config diagnostics: ${args.config.diagnostics.length} (${errors.length} errors, ${warnings.length} warnings)`,
    `Adapter health checks: ${args.adapterHealth.length} (${unhealthyAdapters.length} attention needed)`,
    `Background task dir: ${args.backgroundDirExists ? "ready" : "missing"} — ${args.backgroundDir}`,
    `Debug dir: ${args.debugDirExists ? "ready" : "missing"} — ${args.debugDir}`,
    `Workflow state file: ${args.workflowStateExists ? "present" : "not yet created"} — ${args.workflowStatePath}`,
    `tmux available: ${args.tmuxAvailable ? "yes" : "no"}`,
    `inside tmux: ${args.inTmux ? "yes" : "no"}`,
    `Known background tasks: ${args.taskCount}`,
    "",
    "Checks:",
    `- Config: ${errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok"}`,
    `- Adapters: ${unhealthyAdapters.some((item) => item.status === "error") ? "error" : unhealthyAdapters.length > 0 ? "warning" : "ok"}`,
    `- Multiplexer: ${args.tmuxAvailable ? args.inTmux ? "ok" : "warning" : "warning"}`,
    `- Background storage: ${args.backgroundDirExists ? "ok" : "warning"}`,
    `- Debug artifacts: ${args.debugDirExists ? "ok" : "warning"}`,
    ...(args.config.diagnostics.length > 0 ? ["", "Config diagnostics:", ...args.config.diagnostics.map(formatDiagnostic)] : []),
    ...(args.adapterHealth.length > 0 ? ["", "Adapter health:", ...args.adapterHealth.map((item) => `- ${item.id} [${item.status}] auth=${item.auth ?? "unknown"} — ${item.summary}`)] : []),
    "",
    "Suggested next steps:",
    ...(errors.length > 0 ? ["- Fix config errors first, then rerun /pantheon-doctor."] : []),
    ...(warnings.length > 0 ? ["- Review /pantheon-config for merged config details and warning context."] : []),
    ...(!args.tmuxAvailable ? ["- Install tmux if you want attach/reuse pane workflows for background tasks."] : []),
    ...(args.tmuxAvailable && !args.inTmux ? ["- Start pi inside tmux to use /pantheon-attach and shared background panes."] : []),
    ...(!args.backgroundDirExists ? ["- Run a background task once to create the task directory, or create it manually if desired."] : []),
    ...(unhealthyAdapters.length > 0 ? ["- Run /pantheon-adapter-health for focused adapter readiness details."] : []),
    ...(args.config.diagnostics.length === 0 && unhealthyAdapters.length === 0 && args.backgroundDirExists ? ["- Pantheon looks healthy. Use /pantheon-overview or /pantheon-backgrounds for ongoing monitoring."] : []),
  ].join("\n");
}

export function buildAdapterPolicyReport(args: {
  agentName?: string;
  adapters: Array<{ id: string; description: string }>;
  registered: Array<{ id: string; description: string }>;
  loadErrors: string[];
}): string {
  const allowedIds = new Set(args.adapters.map((adapter) => adapter.id));
  const blocked = args.registered.filter((adapter) => !allowedIds.has(adapter.id));
  return [
    "Pantheon adapter policy",
    "",
    `Current agent: ${args.agentName ?? "interactive"}`,
    `Allowed adapters: ${args.adapters.length > 0 ? args.adapters.map((adapter) => adapter.id).join(", ") : "(none)"}`,
    `Blocked / unavailable adapters: ${blocked.length > 0 ? blocked.map((adapter) => adapter.id).join(", ") : "(none)"}`,
    "",
    "Allowed adapter details:",
    ...(args.adapters.length > 0 ? args.adapters.map((adapter) => `- ${adapter.id} — ${adapter.description}`) : ["- (none)"]),
    "",
    "Blocked / unavailable adapter details:",
    ...(blocked.length > 0 ? blocked.map((adapter) => `- ${adapter.id} — ${adapter.description}`) : ["- (none)"]),
    ...(args.loadErrors.length > 0 ? ["", "Load errors:", ...args.loadErrors.map((item) => `- ${item}`)] : []),
    "",
    "Suggested next steps:",
    "- Adjust adapters.defaultAllow/defaultDeny or per-agent adapter policy in config if this set is not what you expect.",
    "- Run /pantheon-adapter-health to check readiness and auth status before external research.",
  ].filter((line): line is string => typeof line === "string").join("\n");
}
