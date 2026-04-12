import { loadPantheonConfig } from "../extensions/oh-my-opencode-pi/config.ts";
import { readPantheonEvaluationReport, recordPantheonEvaluationScenario, renderPantheonEvaluationReport } from "../extensions/oh-my-opencode-pi/evals.ts";
import { benchmarkResultsToJson, loadScenarioDefinitions, renderOrchestrationBenchmarkReport, runOrchestrationScenarioCorpus } from "../evals/harness.ts";

async function main() {
  const cwdArg = process.argv.indexOf("--cwd");
  const cwd = cwdArg >= 0 && process.argv[cwdArg + 1] ? process.argv[cwdArg + 1] : process.cwd();
  const json = process.argv.includes("--json");
  const definitions = loadScenarioDefinitions();
  const results = await runOrchestrationScenarioCorpus(definitions);
  const config = loadPantheonConfig(cwd).config;

  for (const result of results) {
    recordPantheonEvaluationScenario(cwd, config, {
      scenarioId: result.scenario.id,
      title: result.scenario.title,
      workflow: result.scenario.workflow,
      kind: "benchmark",
      status: result.actual.passed ? "passed" : "failed",
      durationMs: result.actual.durationMs,
      attempts: result.actual.attempts,
      qualityScore: result.actual.qualityScore,
      fallbackRecovered: result.actual.fallbackRecovered,
      routingMatched: result.actual.routingMatched,
      comparison: result.comparison,
      baselineLabel: result.scenario.baseline.label,
      notes: result.reasons,
    });
  }

  if (json) {
    console.log(JSON.stringify(benchmarkResultsToJson(results), null, 2));
    return;
  }

  const report = renderOrchestrationBenchmarkReport(results);
  const evalSummary = renderPantheonEvaluationReport(readPantheonEvaluationReport(cwd, config));

  console.log(report);
  console.log("\n---\n");
  console.log(evalSummary);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
