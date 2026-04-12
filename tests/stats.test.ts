import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyFailureKind,
  readPantheonStats,
  recordAdapterUsage,
  recordBackgroundStatus,
  recordCategoryRun,
  recordToolRun,
  renderPantheonStats,
} from "../extensions/oh-my-opencode-pi/stats.ts";
import { readPantheonEvaluationReport, recordPantheonEvaluationScenario } from "../extensions/oh-my-opencode-pi/evals.ts";

test("Pantheon stats accumulate categories, tools, adapters, and failure diagnostics", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-stats-"));
  const config = {} as never;

  recordCategoryRun(tempRoot, config, "delegate", "success", 1200, "single", "fixer");
  recordCategoryRun(tempRoot, config, "council", "failed", 900, "council");
  recordToolRun(tempRoot, config, "pantheon_delegate", "success", 1200);
  recordToolRun(tempRoot, config, "pantheon_adapter_search", "failed", 340, "adapter");
  recordAdapterUsage(tempRoot, config, "local-docs", "search", false);
  recordAdapterUsage(tempRoot, config, "github-code-search", "fetch", true);
  recordBackgroundStatus(tempRoot, config, "queued", "fixer:bg1");
  recordBackgroundStatus(tempRoot, config, "completed", "fixer:bg1");

  recordPantheonEvaluationScenario(tempRoot, config, {
    scenarioId: "delegate-fallback-recovery",
    title: "Delegate fallback recovers from an empty primary response",
    workflow: "delegate",
    kind: "benchmark",
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

  const stats = readPantheonStats(tempRoot, config);
  const evalReport = readPantheonEvaluationReport(tempRoot, config);
  assert.equal(stats.categories.delegate.success, 1);
  assert.equal(stats.categories.council.failed, 1);
  assert.equal(stats.agents.fixer.success, 1);
  assert.equal(stats.tools.pantheon_delegate.success, 1);
  assert.equal(stats.tools.pantheon_adapter_search.failed, 1);
  assert.equal(stats.failureKinds.adapter, 1);
  assert.equal(stats.adapters["local-docs"].searches, 1);
  assert.equal(stats.adapters["github-code-search"].failures, 1);
  assert.equal(stats.background.completed, 1);
  assert.equal(classifyFailureKind("pantheon_lsp_hover", true), "lsp");
  const rendered = renderPantheonStats(stats, evalReport);
  assert.match(rendered, /Insights:/);
  assert.match(rendered, /Most-used tool:/);
  assert.match(rendered, /Background completion rate:/);
  assert.match(rendered, /Tools:|Failure kinds:|local-docs|Background/);
  assert.match(rendered, /Evaluations:/);
  assert.match(rendered, /Orchestration eval pass rate:/);
  assert.ok(fs.existsSync(path.join(tempRoot, ".oh-my-opencode-pi-stats.json")));
});
