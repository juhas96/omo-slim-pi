import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("adapter policy supports wildcard allow and deny semantics closer to MCP-style config", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-adapter-policy-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.jsonc"), `{
    "adapters": {
      "defaultAllow": ["*"],
      "defaultDeny": ["github-releases", "!grep-app"]
    }
  }`);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const tools = new Map<string, any>();
    const fakePi = {
      on() {},
      registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
      registerCommand() {},
      sendUserMessage() {},
    };
    extension(fakePi as never);

    const listTool = tools.get("pantheon_adapter_list");
    const result = await listTool.execute("call-1", {}, undefined, undefined, { cwd: projectDir });
    const text = result.content[0]?.text ?? "";
    const allowedLine = text.split(/\n/).find((line) => line.startsWith("Allowed adapters:")) ?? "";
    assert.match(text, /Allowed adapters:/);
    assert.doesNotMatch(allowedLine, /github-releases/);
    assert.doesNotMatch(allowedLine, /grep-app/);
    assert.match(allowedLine, /local-docs/);
    assert.match(allowedLine, /docs-context7/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
