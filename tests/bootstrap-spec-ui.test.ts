import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";
import { buildSpecStudioTemplate } from "../extensions/oh-my-opencode-pi/setup.ts";

function registerTools() {
  const tools = new Map<string, any>();
  const fakePi = {
    on() {},
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  extension(fakePi as never);
  return tools;
}

test("bootstrap tool scaffolds project-local Pantheon files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-bootstrap-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const tools = registerTools();
  const bootstrapTool = tools.get("pantheon_bootstrap");
  const result = await bootstrapTool.execute("call-1", { force: false }, undefined, undefined, { cwd: projectDir });
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Pantheon bootstrap complete/);
  const configPath = path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc");
  const configText = fs.readFileSync(configPath, "utf8");
  assert.ok(fs.existsSync(configPath));
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "pantheon-adapters", "README.md")));
  assert.match(configText, /"oracle": \{[\s\S]*?"model": "openai\/gpt-4\.1"/);
  assert.match(configText, /"fixer": \{[\s\S]*?"model": "openai\/gpt-4\.1-mini"/);
  assert.match(configText, /"defaultPreset": "review-board"/);
});

test("spec studio templates provide richer iterative planning outlines", () => {
  const refactor = buildSpecStudioTemplate("refactor", "Refactor Auth Boundary", { context: "Workspace: demo", focusAreas: "architecture, rollout" });
  assert.match(refactor, /Migration Plan/);
  assert.match(refactor, /Execution Plan/);
  assert.match(refactor, /Decision Log/);
  assert.match(refactor, /Focus areas: architecture, rollout/);

  const incident = buildSpecStudioTemplate("incident", "Investigate API Outage");
  assert.match(incident, /Impact/);
  assert.match(incident, /Containment/);

});
