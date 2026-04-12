import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("repo map tool summarizes a workspace and adapter policy reflects config disableAll", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-cartography-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "demo" }, null, 2));
  fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    adapters: { disableAll: true },
    skills: { cartography: { enabled: true, maxFiles: 50, maxDepth: 3 } },
  }, null, 2));

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const tools = new Map<string, any>();
    const fakePi = {
      on() {
        // noop
      },
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {
        // noop
      },
      sendUserMessage() {
        // noop
      },
    };

    extension(fakePi as never);

    const repoMapTool = tools.get("pantheon_repo_map");
    const repoMapResult = await repoMapTool.execute("call-1", {}, undefined, undefined, { cwd: projectDir });
    const repoMapText = repoMapResult.content[0]?.text ?? "";
    assert.match(repoMapText, /package\.json/);
    assert.match(repoMapText, /src/);

    const adapterListTool = tools.get("pantheon_adapter_list");
    const adapterListResult = await adapterListTool.execute("call-2", {}, undefined, undefined, { cwd: projectDir });
    const adapterListText = adapterListResult.content[0]?.text ?? "";
    assert.match(adapterListText, /Allowed adapters: \(none\)/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
