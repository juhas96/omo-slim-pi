import test from "node:test";
import assert from "node:assert/strict";
import {
  groupAgentViewRunsForUi,
  launchAgentViewCouncilGroup,
  launchAgentViewRunGroup,
} from "../extensions/oh-my-opencode-pi/agent-view.ts";
import { validatePantheonConfig } from "../extensions/oh-my-opencode-pi/config.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function fixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-activity-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({
    agentView: {
      storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user") },
      supervisor: { socketDir: path.join(tempRoot, "sockets") },
    },
  }).config;
  return { projectDir, config };
}

test("Agent View groups child Run status for parallel and council activity", () => {
  const { projectDir, config } = fixture();
  const parallel = launchAgentViewRunGroup(projectDir, config, { mode: "parallel", runs: [{ task: "map", specialist: "explorer" }, { task: "fix", specialist: "fixer" }] });
  const council = launchAgentViewCouncilGroup(projectDir, config, { prompt: "decide", preset: "review-board", councillors: ["reviewer", "architect"], master: "council-master" });

  const bySpecialist = groupAgentViewRunsForUi([...parallel.runs, ...council.councillorRuns, council.synthesisRun], "specialist");
  assert.equal(bySpecialist.find((group) => group.group === "explorer")?.runs.length, 1);
  assert.equal(bySpecialist.find((group) => group.group === "council-master")?.runs.length, 1);

  const byAction = groupAgentViewRunsForUi([...parallel.runs, ...council.councillorRuns, council.synthesisRun]);
  assert.ok(byAction.some((group) => group.group === "Done"));
});
