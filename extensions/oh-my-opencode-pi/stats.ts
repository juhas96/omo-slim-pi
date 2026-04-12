import * as fs from "node:fs";
import * as path from "node:path";
import type { PantheonConfig } from "./config.js";
import { buildPantheonEvaluationInsights, type PantheonEvaluationReport } from "./evals.js";

export interface PantheonStatsRecord {
  updatedAt: number;
  categories: Record<string, { success: number; failed: number; totalDurationMs: number }>;
  agents: Record<string, { success: number; failed: number; totalDurationMs: number }>;
  tools: Record<string, { success: number; failed: number; totalDurationMs: number }>;
  adapters: Record<string, { searches: number; fetches: number; failures: number }>;
  failureKinds: Record<string, number>;
  background: { queued: number; completed: number; failed: number; cancelled: number };
  recent: Array<{ kind: string; label: string; status: string; durationMs?: number; ts: number; failureKind?: string }>;
}

function getDefaultStats(): PantheonStatsRecord {
  return {
    updatedAt: 0,
    categories: {},
    agents: {},
    tools: {},
    adapters: {},
    failureKinds: {},
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
    recent: (stats.recent ?? []).slice(-40),
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

function touchTool(stats: PantheonStatsRecord, key: string) {
  stats.tools[key] = stats.tools[key] ?? { success: 0, failed: 0, totalDurationMs: 0 };
  return stats.tools[key];
}

function touchAdapter(stats: PantheonStatsRecord, key: string) {
  stats.adapters[key] = stats.adapters[key] ?? { searches: 0, fetches: 0, failures: 0 };
  return stats.adapters[key];
}

function averageDuration(bucket: { success: number; failed: number; totalDurationMs: number }): number {
  const total = bucket.success + bucket.failed;
  if (total <= 0) return 0;
  return Math.round(bucket.totalDurationMs / total);
}

export function buildPantheonStatsInsights(stats: PantheonStatsRecord, evalReport?: PantheonEvaluationReport): string[] {
  const insights: string[] = [];
  const busiestTool = Object.entries(stats.tools)
    .sort(([, a], [, b]) => (b.success + b.failed) - (a.success + a.failed) || b.totalDurationMs - a.totalDurationMs)[0];
  if (busiestTool) {
    const [tool, bucket] = busiestTool;
    insights.push(`- Most-used tool: ${tool} (${bucket.success + bucket.failed} runs, ${averageDuration(bucket)}ms avg)`);
  }
  const noisiestFailure = Object.entries(stats.failureKinds).sort(([, a], [, b]) => b - a)[0];
  if (noisiestFailure) {
    insights.push(`- Highest failure area: ${noisiestFailure[0]} (${noisiestFailure[1]} failures)`);
  }
  const failureProneTool = Object.entries(stats.tools)
    .filter(([, bucket]) => bucket.failed > 0)
    .sort(([, a], [, b]) => b.failed - a.failed || (b.success + b.failed) - (a.success + a.failed))[0];
  if (failureProneTool) {
    const [tool, bucket] = failureProneTool;
    insights.push(`- Most failure-prone tool: ${tool} (${bucket.failed} failed / ${bucket.success + bucket.failed} total)`);
  }
  const terminalBackground = stats.background.completed + stats.background.failed + stats.background.cancelled;
  if (terminalBackground > 0) {
    const completionRate = Math.round((stats.background.completed / terminalBackground) * 100);
    insights.push(`- Background completion rate: ${completionRate}% (${stats.background.completed}/${terminalBackground})`);
  }
  const busiestAgent = Object.entries(stats.agents).sort(([, a], [, b]) => (b.success + b.failed) - (a.success + a.failed))[0];
  if (busiestAgent) {
    const [agent, bucket] = busiestAgent;
    insights.push(`- Most active agent: ${agent} (${bucket.success + bucket.failed} runs)`);
  }
  if (evalReport) insights.push(...buildPantheonEvaluationInsights(evalReport));
  if (insights.length === 0) insights.push("- Not enough activity yet to derive insights.");
  return insights;
}

export function classifyFailureKind(toolName: string, isError: boolean): string | undefined {
  if (!isError) return undefined;
  if (toolName.startsWith("pantheon_adapter_")) return "adapter";
  if (toolName.startsWith("pantheon_lsp_")) return "lsp";
  if (toolName.startsWith("pantheon_ast_grep_")) return "refactor";
  if (toolName.startsWith("pantheon_background")) return "background";
  if (toolName === "pantheon_delegate") return "delegate";
  if (toolName === "pantheon_council") return "council";
  if (toolName === "pantheon_apply_patch") return "patch";
  return toolName.startsWith("pantheon_") ? "pantheon" : undefined;
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

export function recordToolRun(cwd: string, config: PantheonConfig, toolName: string, status: "success" | "failed", durationMs: number, failureKind?: string): PantheonStatsRecord {
  return updatePantheonStats(cwd, config, (stats) => {
    const tool = touchTool(stats, toolName);
    if (status === "success") tool.success += 1;
    else tool.failed += 1;
    tool.totalDurationMs += Math.max(0, Math.floor(durationMs));
    if (failureKind) stats.failureKinds[failureKind] = (stats.failureKinds[failureKind] ?? 0) + 1;
    stats.recent.push({ kind: "tool", label: toolName, status, durationMs: Math.max(0, Math.floor(durationMs)), ts: Date.now(), failureKind });
    return stats;
  });
}

export function recordAdapterUsage(cwd: string, config: PantheonConfig, adapterId: string, mode: "search" | "fetch", failed = false): PantheonStatsRecord {
  return updatePantheonStats(cwd, config, (stats) => {
    const adapter = touchAdapter(stats, adapterId);
    if (mode === "search") adapter.searches += 1;
    else adapter.fetches += 1;
    if (failed) adapter.failures += 1;
    stats.recent.push({ kind: `adapter:${mode}`, label: adapterId, status: failed ? "failed" : "success", ts: Date.now(), failureKind: failed ? "adapter" : undefined });
    return stats;
  });
}

export function recordBackgroundStatus(cwd: string, config: PantheonConfig, status: "queued" | "completed" | "failed" | "cancelled", label: string): PantheonStatsRecord {
  return updatePantheonStats(cwd, config, (stats) => {
    stats.background[status] += 1;
    stats.recent.push({ kind: "background", label, status, ts: Date.now(), failureKind: status === "failed" ? "background" : undefined });
    return stats;
  });
}

export function renderPantheonStats(stats: PantheonStatsRecord, evalReport?: PantheonEvaluationReport): string {
  const categoryLines = Object.entries(stats.categories)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `- ${name}: ${value.success} success / ${value.failed} failed / ${averageDuration(value)}ms avg / ${value.totalDurationMs}ms total`);
  const agentLines = Object.entries(stats.agents)
    .sort(([, a], [, b]) => (b.success + b.failed) - (a.success + a.failed))
    .slice(0, 10)
    .map(([name, value]) => `- ${name}: ${value.success} success / ${value.failed} failed / ${averageDuration(value)}ms avg / ${value.totalDurationMs}ms total`);
  const toolLines = Object.entries(stats.tools)
    .sort(([, a], [, b]) => (b.success + b.failed) - (a.success + a.failed) || b.totalDurationMs - a.totalDurationMs)
    .slice(0, 12)
    .map(([name, value]) => `- ${name}: ${value.success} success / ${value.failed} failed / ${averageDuration(value)}ms avg / ${value.totalDurationMs}ms total`);
  const adapterLines = Object.entries(stats.adapters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `- ${name}: ${value.searches} searches / ${value.fetches} fetches / ${value.failures} failures`);
  const failureLines = Object.entries(stats.failureKinds)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `- ${name}: ${count}`);
  const insightLines = buildPantheonStatsInsights(stats, evalReport);
  return [
    `Updated: ${stats.updatedAt ? new Date(stats.updatedAt).toISOString() : "(never)"}`,
    insightLines.length > 0 ? `\nInsights:\n${insightLines.join("\n")}` : "\nInsights:\n(none)",
    categoryLines.length > 0 ? `\nCategories:\n${categoryLines.join("\n")}` : "\nCategories:\n(none)",
    agentLines.length > 0 ? `\nAgents:\n${agentLines.join("\n")}` : "\nAgents:\n(none)",
    toolLines.length > 0 ? `\nTools:\n${toolLines.join("\n")}` : "\nTools:\n(none)",
    adapterLines.length > 0 ? `\nAdapters:\n${adapterLines.join("\n")}` : "\nAdapters:\n(none)",
    failureLines.length > 0 ? `\nFailure kinds:\n${failureLines.join("\n")}` : "\nFailure kinds:\n(none)",
    `\nBackground:\n- queued: ${stats.background.queued}\n- completed: ${stats.background.completed}\n- failed: ${stats.background.failed}\n- cancelled: ${stats.background.cancelled}`,
    evalReport ? `\nEvaluations:\n- scenarios run: ${evalReport.summary.scenariosRun}\n- passed: ${evalReport.summary.scenariosPassed}\n- failed: ${evalReport.summary.scenariosFailed}\n- benchmark runs: ${evalReport.summary.benchmarkRuns}\n- orchestration wins: ${evalReport.summary.orchestrationWins}\n- baseline wins: ${evalReport.summary.baselineWins}\n- ties: ${evalReport.summary.ties}\n- fallback recoveries: ${evalReport.summary.fallbackRecoveries}\n- routing mismatches: ${evalReport.summary.routingMismatches}` : undefined,
    stats.recent.length > 0 ? `\nRecent:\n${stats.recent.slice(-12).map((item) => `- ${new Date(item.ts).toISOString()} ${item.kind} ${item.label} [${item.status}]${typeof item.durationMs === "number" ? ` ${item.durationMs}ms` : ""}${item.failureKind ? ` kind:${item.failureKind}` : ""}`).join("\n")}` : "\nRecent:\n(none)",
  ].join("\n");
}
