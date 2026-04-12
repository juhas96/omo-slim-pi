import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadScenarioDefinitions, runOrchestrationScenario } from "../evals/harness.ts";

function fixture(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", name), "utf8");
}

test("orchestration scenario timelines match approval fixtures", async () => {
  const definitions = loadScenarioDefinitions();
  const delegate = definitions.find((item) => item.id === "delegate-fallback-recovery");
  const council = definitions.find((item) => item.id === "council-synthesis-progress");
  const doctor = definitions.find((item) => item.id === "doctor-config-diagnostics");
  assert.ok(delegate && council && doctor);

  const delegateResult = await runOrchestrationScenario(delegate);
  const councilResult = await runOrchestrationScenario(council);
  const doctorResult = await runOrchestrationScenario(doctor);

  assert.equal(delegateResult.timeline, fixture("orchestration-delegate-fallback.txt"));
  assert.equal(councilResult.timeline, fixture("orchestration-council-progress.txt"));
  assert.equal(doctorResult.timeline, fixture("orchestration-doctor-report.txt"));
});
