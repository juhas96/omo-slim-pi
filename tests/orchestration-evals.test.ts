import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPantheonConfig } from "../extensions/oh-my-opencode-pi/config.ts";
import {
  readPantheonEvaluationReport,
  recordPantheonEvaluationScenario,
  renderPantheonEvaluationReport,
} from "../extensions/oh-my-opencode-pi/evals.ts";
import {
  loadScenarioDefinitions,
  renderOrchestrationBenchmarkReport,
  runOrchestrationScenario,
  runOrchestrationScenarioCorpus,
} from "../evals/harness.ts";

test("deterministic orchestration scenarios pass for delegate, council, background, adapters, and doctor flows", async () => {
  const definitions = loadScenarioDefinitions();
  const results = [];
  for (const definition of definitions) {
    results.push(await runOrchestrationScenario(definition));
  }
  assert.equal(results.length, definitions.length);
  for (const result of results) {
    assert.equal(result.passed, true, `${result.scenarioId} should pass`);
    assert.ok(result.durationMs > 0);
    assert.ok(result.attempts >= 1);
    assert.ok(result.timeline.length > 0);
  }

  const delegate = results.find((result) => result.scenarioId === "delegate-fallback-recovery");
  assert.equal(delegate?.fallbackRecovered, true);

  const adapter = results.find((result) => result.scenarioId === "adapter-local-docs-routing");
  assert.equal(adapter?.routingMatched, true);

  const doctor = results.find((result) => result.scenarioId === "doctor-config-diagnostics");
  assert.match(doctor?.timeline ?? "", /Suggested next steps:/);
});

test("orchestration benchmark corpus compares scenarios against baseline fixtures", async () => {
  const results = await runOrchestrationScenarioCorpus();
  assert.ok(results.length >= 5);
  assert.ok(results.some((result) => result.comparison === "orchestration"));
  const report = renderOrchestrationBenchmarkReport(results);
  assert.match(report, /Benchmark outcomes:/);
  assert.match(report, /delegate-fallback-recovery/);
  assert.match(report, /council-synthesis-progress/);
});

test("evaluation report records scenario runs and renders summaries", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-eval-report-"));
  const config = loadPantheonConfig(tempRoot).config;

  recordPantheonEvaluationScenario(tempRoot, config, {
    scenarioId: "delegate-fallback-recovery",
    title: "Delegate fallback recovers from an empty primary response",
    workflow: "delegate",
    kind: "deterministic",
    status: "passed",
    durationMs: 120,
    attempts: 2,
    qualityScore: 1,
    fallbackRecovered: true,
    routingMatched: true,
    comparison: "orchestration",
    baselineLabel: "direct-single-primary",
    notes: ["Recovered via fallback backup model."],
  });

  recordPantheonEvaluationScenario(tempRoot, config, {
    scenarioId: "adapter-local-docs-routing",
    title: "Adapter auto-selection prefers local docs for repo documentation queries",
    workflow: "adapter-search",
    kind: "benchmark",
    status: "passed",
    durationMs: 80,
    attempts: 1,
    qualityScore: 1,
    routingMatched: true,
    comparison: "orchestration",
    baselineLabel: "generic-web-search",
    notes: ["Top adapter: local-docs"],
  });

  const report = readPantheonEvaluationReport(tempRoot, config);
  assert.equal(report.summary.scenariosRun, 2);
  assert.equal(report.summary.scenariosPassed, 2);
  assert.equal(report.summary.benchmarkRuns, 1);
  assert.equal(report.summary.orchestrationWins, 2);
  assert.equal(report.summary.fallbackRecoveries, 1);

  const rendered = renderPantheonEvaluationReport(report);
  assert.match(rendered, /fallback recoveries: 1/);
  assert.match(rendered, /orchestration wins: 2/);
  assert.match(rendered, /delegate-fallback-recovery/);
});
