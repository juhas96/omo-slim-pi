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
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    sendUserMessage() {},
  };
  extension(fakePi as never);
  return tools;
}

test("pantheon_delegate and pantheon_council execute through the subagent runner", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const tools = registerTools();
    const delegateTool = tools.get("pantheon_delegate");
    const delegateResult = await delegateTool.execute("call-1", { agent: "fixer", task: "Implement a tiny change" }, undefined, undefined, { cwd: projectDir });
    assert.equal(delegateResult.isError, false);
    assert.match(delegateResult.content[0]?.text ?? "", /ok:Task:/);

    const councilTool = tools.get("pantheon_council");
    const councilResult = await councilTool.execute("call-2", { prompt: "Should we proceed?", preset: "quick" }, undefined, undefined, { cwd: projectDir });
    assert.equal(councilResult.isError, false);
    assert.match(councilResult.content[0]?.text ?? "", /Council preset: quick/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_delegate reports failures from the subagent runner", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-fail-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const badPiScript = path.join(tempRoot, "bad-pi.mjs");
  fs.writeFileSync(badPiScript, `
    console.error("simulated failure");
    process.exit(1);
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = badPiScript;
  try {
    const tools = registerTools();
    const delegateTool = tools.get("pantheon_delegate");
    const result = await delegateTool.execute("call-3", { agent: "fixer", task: "Fail this run" }, undefined, undefined, { cwd: projectDir });
    assert.equal(result.isError, true);
  } finally {
    process.argv[1] = originalArgv1;
  }
});
