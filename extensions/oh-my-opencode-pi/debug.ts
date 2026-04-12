import * as fs from "node:fs";
import * as path from "node:path";
import type { PantheonConfig } from "./config.js";

export interface DebugTraceContext {
  id: string;
  kind: string;
  dir: string;
  eventsPath: string;
  summaryPath: string;
}

export interface SubagentDebugContext {
  traceId: string;
  label: string;
  dir: string;
  stdoutPath: string;
  stderrPath: string;
  summaryPath: string;
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

export function resolveDebugLogDir(cwd: string, config: PantheonConfig): string {
  const configured = config.debug?.logDir?.trim() || ".oh-my-opencode-pi-debug";
  return ensureDir(path.isAbsolute(configured) ? configured : path.join(cwd, configured));
}

export function writeDebugText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text, "utf8");
}

export function writeDebugJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function createDebugTrace(cwd: string, config: PantheonConfig, kind: string, payload: Record<string, unknown>): DebugTraceContext | undefined {
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

export function appendDebugEvent(trace: DebugTraceContext | undefined, type: string, payload: Record<string, unknown>): void {
  if (!trace) return;
  writeDebugText(trace.eventsPath, `${JSON.stringify({ ts: Date.now(), type, ...payload })}\n`);
}

export function updateDebugTraceSummary(trace: DebugTraceContext | undefined, payload: Record<string, unknown>): void {
  if (!trace) return;
  const current = fs.existsSync(trace.summaryPath)
    ? JSON.parse(fs.readFileSync(trace.summaryPath, "utf8")) as Record<string, unknown>
    : {};
  writeDebugJson(trace.summaryPath, { ...current, ...payload });
}

export function createSubagentDebugContext(
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

export function listDebugTraces(debugDir: string): Array<{ id: string; summaryPath: string; summary?: Record<string, unknown> }> {
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
