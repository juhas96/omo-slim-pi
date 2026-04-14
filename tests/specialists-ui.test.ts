import test from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../extensions/oh-my-opencode-pi/agents.ts";
import {
  buildPantheonQuickHelpReport,
  buildPantheonSpecialistPickerDescription,
  buildPantheonSpecialistPickerLabel,
  buildPantheonSubagentInspectorLabel,
  getPantheonSpecialistGuide,
} from "../extensions/oh-my-opencode-pi/specialists.ts";

function bundled(name: string): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPrompt: "",
    source: "bundled",
    filePath: `/tmp/${name}.md`,
  };
}

test("specialist picker helpers expose Pantheon-native categories and descriptions", () => {
  assert.equal(buildPantheonSpecialistPickerLabel("explorer"), "Investigate · explorer");
  assert.match(buildPantheonSpecialistPickerDescription("fixer"), /Implement once direction is clear/);
  assert.match(buildPantheonSpecialistPickerDescription("oracle"), /Decide safely/);
  assert.equal(buildPantheonSubagentInspectorLabel("reviewer", "councillor"), "reviewer · council member");
  assert.equal(buildPantheonSubagentInspectorLabel("master", "council-master"), "master · council synthesis");
  assert.equal(getPantheonSpecialistGuide("council-master")?.shortLabel, "Council synthesis");
});

test("specialist quick-help report stays concise and action-oriented", () => {
  const report = buildPantheonQuickHelpReport([
    bundled("explorer"),
    bundled("librarian"),
    bundled("oracle"),
    bundled("designer"),
    bundled("fixer"),
    bundled("council"),
  ]);

  assert.match(report, /Which specialist should I use\?/);
  assert.match(report, /Investigate · explorer/);
  assert.match(report, /Implement · fixer/);
  assert.match(report, /Consensus · council/);
  assert.match(report, /Use \/pantheon-as <specialist> <task>/);
});
