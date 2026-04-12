import * as fs from "node:fs";
import * as path from "node:path";
import type { PantheonConfig } from "./config.js";

export interface PantheonEvaluationScenarioRun {
  scenarioId: string;
  title: string;
  workflow: string;
  kind: "deterministic" | "benchmark" | "approval";
  status: "passed" | "failed";
  durationMs?: number;
  attempts?: number;
  qualityScore?: number;
  fallbackRecovered?: boolean;
  routingMatched?: boolean;
  comparison?: "orchestration" | "baseline" | "tie";
  baselineLabel?: string;
  notes?: string[];
  ts: number;
}

export interface PantheonEvaluationReport {
  updatedAt: number;
  summary: {
    scenariosRun: number;
    scenariosPassed: number;
    scenariosFailed: number;
    benchmarkRuns: number;
    orchestrationWins: number;
    baselineWins: number;
    ties: number;
    fallbackRecoveries: number;
    routingMismatches: number;
  };
  recent: PantheonEvaluationScenarioRun[];
}

function getDefaultEvaluationReport(): PantheonEvaluationReport {
  return {
    updatedAt: 0,
    summary: {
      scenariosRun: 0,
      scenariosPassed: 0,
      scenariosFailed: 0,
      benchmarkRuns: 0,
      orchestrationWins: 0,
      baselineWins: 0,
      ties: 0,
      fallbackRecoveries: 0,
      routingMismatches: 0,
    },
    recent: [],
  };
}

export function resolvePantheonEvaluationPath(cwd: string, _config: PantheonConfig): string {
  return path.join(cwd, ".oh-my-opencode-pi-evals.json");
}

export function readPantheonEvaluationReport(cwd: string, config: PantheonConfig): PantheonEvaluationReport {
  const filePath = resolvePantheonEvaluationPath(cwd, config);
  try {
    return { ...getDefaultEvaluationReport(), ...(JSON.parse(fs.readFileSync(filePath, "utf8")) as PantheonEvaluationReport) };
  } catch {
    return getDefaultEvaluationReport();
  }
}

export function writePantheonEvaluationReport(cwd: string, config: PantheonConfig, report: PantheonEvaluationReport): PantheonEvaluationReport {
  const filePath = resolvePantheonEvaluationPath(cwd, config);
  const normalized: PantheonEvaluationReport = {
    ...report,
    updatedAt: Date.now(),
    recent: (report.recent ?? []).slice(-40),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function updatePantheonEvaluationReport(cwd: string, config: PantheonConfig, mutate: (report: PantheonEvaluationReport) => PantheonEvaluationReport): PantheonEvaluationReport {
  const current = readPantheonEvaluationReport(cwd, config);
  return writePantheonEvaluationReport(cwd, config, mutate(current));
}

export function recordPantheonEvaluationScenario(cwd: string, config: PantheonConfig, run: Omit<PantheonEvaluationScenarioRun, "ts"> & { ts?: number }): PantheonEvaluationReport {
  return updatePantheonEvaluationReport(cwd, config, (report) => {
    const entry: PantheonEvaluationScenarioRun = { ...run, ts: run.ts ?? Date.now() };
    report.summary.scenariosRun += 1;
    if (entry.status === "passed") report.summary.scenariosPassed += 1;
    else report.summary.scenariosFailed += 1;
    if (entry.kind === "benchmark") report.summary.benchmarkRuns += 1;
    if (entry.comparison === "orchestration") report.summary.orchestrationWins += 1;
    else if (entry.comparison === "baseline") report.summary.baselineWins += 1;
    else if (entry.comparison === "tie") report.summary.ties += 1;
    if (entry.fallbackRecovered) report.summary.fallbackRecoveries += 1;
    if (entry.routingMatched === false) report.summary.routingMismatches += 1;
    report.recent.push(entry);
    return report;
  });
}

export function buildPantheonEvaluationInsights(report: PantheonEvaluationReport): string[] {
  const insights: string[] = [];
  if (report.summary.scenariosRun > 0) {
    const passRate = Math.round((report.summary.scenariosPassed / report.summary.scenariosRun) * 100);
    insights.push(`- Orchestration eval pass rate: ${passRate}% (${report.summary.scenariosPassed}/${report.summary.scenariosRun})`);
  }
  if (report.summary.benchmarkRuns > 0) {
    insights.push(`- Benchmark outcomes: ${report.summary.orchestrationWins} orchestration wins / ${report.summary.baselineWins} baseline wins / ${report.summary.ties} ties`);
  }
  if (report.summary.fallbackRecoveries > 0) {
    insights.push(`- Fallback recovery wins: ${report.summary.fallbackRecoveries}`);
  }
  if (report.summary.routingMismatches > 0) {
    insights.push(`- Routing mismatches observed: ${report.summary.routingMismatches}`);
  }
  if (insights.length === 0) insights.push("- No orchestration eval results recorded yet.");
  return insights;
}

export function renderPantheonEvaluationReport(report: PantheonEvaluationReport): string {
  return [
    `Updated: ${report.updatedAt ? new Date(report.updatedAt).toISOString() : "(never)"}`,
    "",
    "Summary:",
    `- scenarios run: ${report.summary.scenariosRun}`,
    `- passed: ${report.summary.scenariosPassed}`,
    `- failed: ${report.summary.scenariosFailed}`,
    `- benchmark runs: ${report.summary.benchmarkRuns}`,
    `- orchestration wins: ${report.summary.orchestrationWins}`,
    `- baseline wins: ${report.summary.baselineWins}`,
    `- ties: ${report.summary.ties}`,
    `- fallback recoveries: ${report.summary.fallbackRecoveries}`,
    `- routing mismatches: ${report.summary.routingMismatches}`,
    "",
    "Insights:",
    ...buildPantheonEvaluationInsights(report),
    "",
    "Recent runs:",
    ...(report.recent.length > 0
      ? report.recent.slice(-12).map((entry) => `- ${new Date(entry.ts).toISOString()} ${entry.scenarioId} [${entry.kind}] ${entry.status}${entry.comparison ? ` compare:${entry.comparison}` : ""}${typeof entry.durationMs === "number" ? ` ${entry.durationMs}ms` : ""}${typeof entry.attempts === "number" ? ` attempts:${entry.attempts}` : ""}`)
      : ["- (none)"]),
  ].join("\n");
}
