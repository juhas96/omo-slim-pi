import * as fs from "node:fs";
import * as path from "node:path";
import type { PantheonConfig } from "./config.js";

export interface PantheonStatsRecord {
  updatedAt: number;
  categories: Record<string, { success: number; failed: number; totalDurationMs: number }>;
  agents: Record<string, { success: number; failed: number; totalDurationMs: number }>;
  adapters: Record<string, { searches: number; fetches: number; failures: number }>;
  background: { queued: number; completed: number; failed: number; cancelled: number };
  recent: Array<{ kind: string; label: string; status: string; durationMs?: number; ts: number }>;
}

function getDefaultStats(): PantheonStatsRecord {
  return {
    updatedAt: 0,
    categories: {},
    agents: {},
    adapters: {},
    background: { queued: 0, completed: 0, failed: 0, cancelled: 0 },
    recent: [],
  };
}

export function resolveStatsPath(cwd: string, _config: PantheonConfig): string {
  return path.join(cwd, ".oh-my-opencode-pi-stats.json");
}

export function readPantheonStats(cwd: string, config: PantheonConfig): PantheonStatsRecord {
  const filePath = resolveStatsPath(cwd, config);
  try {
    return { ...getDefaultStats(), ...(JSON.parse(fs.readFileSync(filePath, "utf8")) as PantheonStatsRecord) };
  } catch {
    return getDefaultStats();
  }
}

export function writePantheonStats(cwd: string, config: PantheonConfig, stats: PantheonStatsRecord): PantheonStatsRecord {
  const filePath = resolveStatsPath(cwd, config);
  const normalized: PantheonStatsRecord = {
    ...stats,
    updatedAt: Date.now(),
    recent: (stats.recent ?? []).slice(-30),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function updatePantheonStats(cwd: string, config: PantheonConfig, mutate: (stats: PantheonStatsRecord) => PantheonStatsRecord): PantheonStatsRecord {
  const current = readPantheonStats(cwd, config);
  return writePantheonStats(cwd, config, mutate(current));
}

function touchCategory(stats: PantheonStatsRecord, key: string) {
  stats.categories[key] = stats.categories[key] ?? { success: 0, failed: 0, totalDurationMs: 0 };
  return stats.categories[key];
}

function touchAgent(stats: PantheonStatsRecord, key: string) {
  stats.agents[key] = stats.agents[key] ?? { success: 0, failed: 0, totalDurationMs: 0 };
  return stats.agents[key];
}

function touchAdapter(stats: PantheonStatsRecord, key: string) {
  stats.adapters[key] = stats.adapters[key] ?? { searches: 0, fetches: 0, failures: 0 };
  return stats.adapters[key];
}

export function recordCategoryRun(cwd: string, config: PantheonConfig, category: string, status: "success" | "failed", durationMs: number, label: string, agentName?: string): PantheonStatsRecord {
  return updatePantheonStats(cwd, config, (stats) => {
    const bucket = touchCategory(stats, category);
    if (status === "success") bucket.success += 1;
    else bucket.failed += 1;
    bucket.totalDurationMs += Math.max(0, Math.floor(durationMs));
    if (agentName) {
      const agent = touchAgent(stats, agentName);
      if (status === "success") agent.success += 1;
      else agent.failed += 1;
      agent.totalDurationMs += Math.max(0, Math.floor(durationMs));
    }
    stats.recent.push({ kind: category, label, status, durationMs: Math.max(0, Math.floor(durationMs)), ts: Date.now() });
    return stats;
  });
}

export function recordAdapterUsage(cwd: string, config: PantheonConfig, adapterId: string, mode: "search" | "fetch", failed = false): PantheonStatsRecord {
  return updatePantheonStats(cwd, config, (stats) => {
    const adapter = touchAdapter(stats, adapterId);
    if (mode === "search") adapter.searches += 1;
    else adapter.fetches += 1;
    if (failed) adapter.failures += 1;
    stats.recent.push({ kind: `adapter:${mode}`, label: adapterId, status: failed ? "failed" : "success", ts: Date.now() });
    return stats;
  });
}

export function recordBackgroundStatus(cwd: string, config: PantheonConfig, status: "queued" | "completed" | "failed" | "cancelled", label: string): PantheonStatsRecord {
  return updatePantheonStats(cwd, config, (stats) => {
    stats.background[status] += 1;
    stats.recent.push({ kind: "background", label, status, ts: Date.now() });
    return stats;
  });
}

export function renderPantheonStats(stats: PantheonStatsRecord): string {
  const categoryLines = Object.entries(stats.categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `- ${name}: ${value.success} success / ${value.failed} failed / ${value.totalDurationMs}ms total`);
  const agentLines = Object.entries(stats.agents)
    .sort(([, a], [, b]) => (b.success + b.failed) - (a.success + a.failed))
    .slice(0, 10)
    .map(([name, value]) => `- ${name}: ${value.success} success / ${value.failed} failed / ${value.totalDurationMs}ms total`);
  const adapterLines = Object.entries(stats.adapters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `- ${name}: ${value.searches} searches / ${value.fetches} fetches / ${value.failures} failures`);
  return [
    `Updated: ${stats.updatedAt ? new Date(stats.updatedAt).toISOString() : "(never)"}`,
    categoryLines.length > 0 ? `\nCategories:\n${categoryLines.join("\n")}` : "\nCategories:\n(none)",
    agentLines.length > 0 ? `\nAgents:\n${agentLines.join("\n")}` : "\nAgents:\n(none)",
    adapterLines.length > 0 ? `\nAdapters:\n${adapterLines.join("\n")}` : "\nAdapters:\n(none)",
    `\nBackground:\n- queued: ${stats.background.queued}\n- completed: ${stats.background.completed}\n- failed: ${stats.background.failed}\n- cancelled: ${stats.background.cancelled}`,
    stats.recent.length > 0 ? `\nRecent:\n${stats.recent.slice(-12).map((item) => `- ${new Date(item.ts).toISOString()} ${item.kind} ${item.label} [${item.status}]${typeof item.durationMs === "number" ? ` ${item.durationMs}ms` : ""}`).join("\n")}` : "\nRecent:\n(none)",
  ].join("\n");
}
