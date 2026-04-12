import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("adapter auto-selection prefers local-docs for repository documentation queries", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-sources-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo\n\nInstallation: run npm install.\n");
  fs.writeFileSync(path.join(projectDir, "docs", "setup.md"), "Usage guide: installation steps and setup notes.\n");

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
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

    const searchTool = tools.get("pantheon_adapter_search");
    const result = await searchTool.execute("call-1", { query: "installation guide" }, undefined, undefined, { cwd: projectDir });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /local-docs/);
    assert.match(text, /README\.md|docs\/setup\.md/);

    const listTool = tools.get("pantheon_adapter_list");
    const listResult = await listTool.execute("call-2", {}, undefined, undefined, { cwd: projectDir });
    const listText = listResult.content[0]?.text ?? "";
    assert.match(listText, /github-code-search/);
    assert.match(listText, /local-docs/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
