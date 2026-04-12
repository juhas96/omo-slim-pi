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

test("pantheon_delegate only uses CLI --tools for built-in toolsets", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-tools-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const argvPiScript = path.join(tempRoot, "argv-pi.mjs");
  fs.writeFileSync(argvPiScript, `
    const args = process.argv.slice(2);
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(args) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = argvPiScript;
  try {
    const tools = registerTools();
    const delegateTool = tools.get("pantheon_delegate");

    const fixerResult = await delegateTool.execute("call-4", { agent: "fixer", task: "Inspect CLI args" }, undefined, undefined, { cwd: projectDir });
    const fixerArgs = fixerResult.content[0]?.text ?? "";
    assert.match(fixerArgs, /"--tools","read,grep,find,ls,bash,edit,write"/);

    const librarianResult = await delegateTool.execute("call-5", { agent: "librarian", task: "Inspect CLI args" }, undefined, undefined, { cwd: projectDir });
    const librarianArgs = librarianResult.content[0]?.text ?? "";
    assert.doesNotMatch(librarianArgs, /"--tools"/);
    assert.match(librarianArgs, /Tool policy:/);
    assert.match(librarianArgs, /pantheon_fetch/);

    const councilResult = await delegateTool.execute("call-6", { agent: "council", task: "Inspect CLI args" }, undefined, undefined, { cwd: projectDir });
    const councilArgs = councilResult.content[0]?.text ?? "";
    assert.doesNotMatch(councilArgs, /"--tools"/);
    assert.match(councilArgs, /Tool policy:/);
    assert.match(councilArgs, /pantheon_council/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});
