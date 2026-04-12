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
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc")));
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "pantheon-adapters", "README.md")));
});

test("spec studio template provides richer non-trivial outlines", () => {
  const refactor = buildSpecStudioTemplate("refactor", "Refactor Auth Boundary");
  assert.match(refactor, /Migration Plan/);
  const incident = buildSpecStudioTemplate("incident", "Investigate API Outage");
  assert.match(incident, /Impact/);
});
