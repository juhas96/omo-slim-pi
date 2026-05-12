import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

function registerTools() {
  const tools = new Map<string, any>();
  const fakePi = {
    on() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  };
  extension(fakePi as never);
  return tools;
}

function projectWithConfig() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-tool-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), JSON.stringify({
    agentView: {
      storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user") },
      supervisor: { socketDir: path.join(tempRoot, "sockets") },
    },
  }));
  return projectDir;
}

test("legacy delegate/council tools are replaced by Agent View launch tools", async () => {
  const tools = registerTools();
  assert.equal(tools.has("pantheon_delegate"), false);
  assert.equal(tools.has("pantheon_council"), false);
  assert.ok(tools.has("agent_view_launch"));
  assert.ok(tools.has("agent_view_launch_group"));

  const cwd = projectWithConfig();
  const launch = await tools.get("agent_view_launch").execute("launch", { task: "inspect", specialist: "explorer" }, undefined, undefined, { cwd });
  assert.equal(launch.isError, false);
  assert.equal(launch.details.run.status, "completed");

  const group = await tools.get("agent_view_launch_group").execute("group", { mode: "parallel", runs: [{ task: "map", specialist: "explorer" }, { task: "review", specialist: "oracle" }] }, undefined, undefined, { cwd });
  assert.equal(group.isError, false);
  assert.equal(group.details.group.kind, "parallel");
  assert.equal(group.details.group.runs.length, 2);
});
