export type PantheonHookName =
  | "session_start"
  | "session_shutdown"
  | "before_agent_start"
  | "context"
  | "before_provider_request"
  | "tool_call"
  | "tool_result"
  | "agent_end";

export interface PantheonTraceEvent {
  sequence: number;
  hook: PantheonHookName;
  ts: number;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface PantheonOrchestrationSnapshot {
  version: 1;
  sequence: number;
  counts: Record<PantheonHookName, number>;
  recent: PantheonTraceEvent[];
  lastPrompt?: string;
  lastTool?: string;
  lastProvider?: string;
  lastSessionReason?: string;
  updatedAt: number;
}

export interface PantheonMiddlewareContext {
  cwd: string;
  snapshot: PantheonOrchestrationSnapshot;
}

export type PantheonMiddleware = (
  event: PantheonTraceEvent,
  context: PantheonMiddlewareContext,
) => void | Partial<PantheonOrchestrationSnapshot>;

const TRACE_LIMIT = 40;
const HOOKS: PantheonHookName[] = [
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "context",
  "before_provider_request",
  "tool_call",
  "tool_result",
  "agent_end",
];

function emptyCounts(): Record<PantheonHookName, number> {
  return Object.fromEntries(HOOKS.map((hook) => [hook, 0])) as Record<PantheonHookName, number>;
}

export function createPantheonOrchestrationSnapshot(): PantheonOrchestrationSnapshot {
  return {
    version: 1,
    sequence: 0,
    counts: emptyCounts(),
    recent: [],
    updatedAt: Date.now(),
  };
}

export function summarizeOrchestrationSnapshot(snapshot: PantheonOrchestrationSnapshot): string {
  const counts = HOOKS
    .filter((hook) => snapshot.counts[hook] > 0)
    .map((hook) => `${hook}=${snapshot.counts[hook]}`)
    .join(", ");
  const recent = snapshot.recent.length > 0
    ? snapshot.recent.slice(-6).map((item) => `- #${item.sequence} ${item.hook}: ${item.summary}`).join("\n")
    : "- (no events yet)";
  return [
    "Pantheon orchestration",
    `Sequence: ${snapshot.sequence}`,
    `Counts: ${counts || "(no hook events yet)"}`,
    snapshot.lastSessionReason ? `Last session reason: ${snapshot.lastSessionReason}` : undefined,
    snapshot.lastProvider ? `Last provider: ${snapshot.lastProvider}` : undefined,
    snapshot.lastTool ? `Last tool: ${snapshot.lastTool}` : undefined,
    snapshot.lastPrompt ? `Last prompt: ${snapshot.lastPrompt}` : undefined,
    "",
    "Recent events:",
    recent,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function restorePantheonOrchestrationSnapshot(value: unknown): PantheonOrchestrationSnapshot {
  const base = createPantheonOrchestrationSnapshot();
  if (!value || typeof value !== "object") return base;
  const input = value as Partial<PantheonOrchestrationSnapshot> & { counts?: Record<string, unknown>; recent?: unknown[] };
  const counts = emptyCounts();
  for (const hook of HOOKS) {
    const raw = input.counts?.[hook];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) counts[hook] = Math.floor(raw);
  }
  const recent: PantheonTraceEvent[] = [];
  if (Array.isArray(input.recent)) {
    for (const item of input.recent) {
      if (!item || typeof item !== "object") continue;
      const record = item as Partial<PantheonTraceEvent>;
      if (!HOOKS.includes(record.hook as PantheonHookName)) continue;
      if (typeof record.sequence !== "number" || !Number.isFinite(record.sequence)) continue;
      if (typeof record.summary !== "string") continue;
      recent.push({
        sequence: Math.floor(record.sequence),
        hook: record.hook as PantheonHookName,
        ts: typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : Date.now(),
        summary: record.summary,
        detail: record.detail && typeof record.detail === "object" ? record.detail as Record<string, unknown> : undefined,
      });
    }
  }
  return {
    version: 1,
    sequence: typeof input.sequence === "number" && Number.isFinite(input.sequence) ? Math.max(0, Math.floor(input.sequence)) : base.sequence,
    counts,
    recent: recent.slice(-TRACE_LIMIT),
    lastPrompt: typeof input.lastPrompt === "string" ? input.lastPrompt : undefined,
    lastTool: typeof input.lastTool === "string" ? input.lastTool : undefined,
    lastProvider: typeof input.lastProvider === "string" ? input.lastProvider : undefined,
    lastSessionReason: typeof input.lastSessionReason === "string" ? input.lastSessionReason : undefined,
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : base.updatedAt,
  };
}

export function restorePantheonOrchestrationFromEntries(entries: Array<{ type?: string; customType?: string; data?: unknown }>): PantheonOrchestrationSnapshot {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === "pantheon-orchestration") {
      return restorePantheonOrchestrationSnapshot(entry.data);
    }
  }
  return createPantheonOrchestrationSnapshot();
}

export class PantheonOrchestrationRuntime {
  private snapshot: PantheonOrchestrationSnapshot;
  private middleware = new Map<PantheonHookName, PantheonMiddleware[]>();

  constructor(snapshot?: PantheonOrchestrationSnapshot) {
    this.snapshot = restorePantheonOrchestrationSnapshot(snapshot);
    for (const hook of HOOKS) this.middleware.set(hook, []);
  }

  getSnapshot(): PantheonOrchestrationSnapshot {
    return restorePantheonOrchestrationSnapshot(this.snapshot);
  }

  restore(snapshot: PantheonOrchestrationSnapshot): PantheonOrchestrationSnapshot {
    this.snapshot = restorePantheonOrchestrationSnapshot(snapshot);
    return this.getSnapshot();
  }

  use(hook: PantheonHookName, middleware: PantheonMiddleware): void {
    this.middleware.get(hook)?.push(middleware);
  }

  record(hook: PantheonHookName, summary: string, detail: Record<string, unknown>, cwd: string): PantheonTraceEvent {
    const event: PantheonTraceEvent = {
      sequence: this.snapshot.sequence + 1,
      hook,
      ts: Date.now(),
      summary,
      detail,
    };
    this.snapshot.sequence = event.sequence;
    this.snapshot.counts[hook] += 1;
    this.snapshot.updatedAt = event.ts;
    this.snapshot.recent = [...this.snapshot.recent, event].slice(-TRACE_LIMIT);
    if (detail.prompt && typeof detail.prompt === "string") this.snapshot.lastPrompt = detail.prompt;
    if (detail.toolName && typeof detail.toolName === "string") this.snapshot.lastTool = detail.toolName;
    if (detail.provider && typeof detail.provider === "string") this.snapshot.lastProvider = detail.provider;
    if (detail.reason && typeof detail.reason === "string" && hook === "session_start") this.snapshot.lastSessionReason = detail.reason;

    const context: PantheonMiddlewareContext = { cwd, snapshot: this.snapshot };
    for (const middleware of this.middleware.get(hook) ?? []) {
      const patch = middleware(event, context);
      if (patch) {
        this.snapshot = restorePantheonOrchestrationSnapshot({ ...this.snapshot, ...patch });
      }
    }
    return event;
  }
}
