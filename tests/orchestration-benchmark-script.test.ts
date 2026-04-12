import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { loadPantheonConfig } from "../extensions/oh-my-opencode-pi/config.ts";
import { readPantheonEvaluationReport } from "../extensions/oh-my-opencode-pi/evals.ts";

test("orchestration benchmark script emits JSON and writes an eval report", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-orchestration-bench-"));
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  const scriptPath = path.join(process.cwd(), "scripts", "run-orchestration-bench.ts");
  const output = execFileSync(tsxBin, [scriptPath, "--cwd", tempRoot, "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(output) as { scenarios: Array<{ id: string; comparison: string; passed: boolean }> };
  assert.ok(parsed.scenarios.length >= 5);
  assert.ok(parsed.scenarios.every((scenario) => typeof scenario.id === "string"));

  const report = readPantheonEvaluationReport(tempRoot, loadPantheonConfig(tempRoot).config);
  assert.ok(report.summary.scenariosRun >= parsed.scenarios.length);
  assert.ok(report.summary.orchestrationWins >= 1);
});
