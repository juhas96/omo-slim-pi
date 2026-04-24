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
    registerMessageRenderer() {},
    sendMessage() {},
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

test("pantheon_delegate single-mode progress updates include delegate details", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-single-progress-"));
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
    const partials: any[] = [];
    const result = await delegateTool.execute(
      "call-single-progress",
      { agent: "oracle", task: "Review this repository" },
      undefined,
      (partial: any) => partials.push(partial),
      { cwd: projectDir },
    );

    assert.equal(result.isError, false);
    assert.ok(partials.length > 0);
    assert.ok(partials.some((partial) => partial.details?.mode === "single"));
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_delegate resolves shortly after a final assistant message even if the child lingers", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-linger-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.json"), JSON.stringify({
    fallback: { delegateTimeoutMs: 5000, retryOnEmpty: false, finalMessageGraceMs: 50 },
    workflow: { persistTodos: false },
  }, null, 2));

  const lingerPiScript = path.join(tempRoot, "linger-pi.mjs");
  fs.writeFileSync(lingerPiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    process.on("SIGTERM", () => process.exit(0));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
    setInterval(() => {}, 1000);
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = lingerPiScript;
  try {
    const tools = registerTools();
    const delegateTool = tools.get("pantheon_delegate");
    const startedAt = Date.now();
    const result = await delegateTool.execute("call-linger", { agent: "fixer", task: "Complete and linger" }, undefined, undefined, { cwd: projectDir });
    const durationMs = Date.now() - startedAt;
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /ok:Task:/);
    assert.ok(durationMs < 1200, `Expected configurable fast completion after final message, got ${durationMs}ms`);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_delegate re-arms the timeout while the child keeps emitting progress", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-progress-timeout-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.json"), JSON.stringify({
    fallback: { delegateTimeoutMs: 250, retryOnEmpty: false },
    workflow: { persistTodos: false },
  }, null, 2));

  const progressPiScript = path.join(tempRoot, "progress-pi.mjs");
  fs.writeFileSync(progressPiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      console.log(JSON.stringify({
        type: "tool_result_end",
        message: {
          role: "tool",
          content: [{ type: "text", text: "progress:" + step }]
        }
      }));
      if (step >= 4) {
        clearInterval(timer);
        console.log(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok:" + task.slice(0, 40) }],
            model: "fake/model",
            stopReason: "end_turn"
          }
        }));
        process.exit(0);
      }
    }, 100);
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = progressPiScript;
  try {
    const tools = registerTools();
    const delegateTool = tools.get("pantheon_delegate");
    const startedAt = Date.now();
    const result = await delegateTool.execute("call-progress-timeout", { agent: "fixer", task: "Stay alive while making progress" }, undefined, undefined, { cwd: projectDir });
    const durationMs = Date.now() - startedAt;
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /ok:Task:/);
    assert.ok(durationMs >= 350, `Expected run to outlast the base timeout because progress kept arriving, got ${durationMs}ms`);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_delegate suppresses benign stale extension ctx stderr from successful child pi runs", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-stale-stderr-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi-stale-stderr.mjs");
  fs.writeFileSync(fakePiScript, `
    const stale = "Extension error (/tmp/ext.ts): This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
    console.error(stale);
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
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
    const result = await delegateTool.execute("call-stale-stderr", { agent: "fixer", task: "Emit benign stderr" }, undefined, undefined, { cwd: projectDir });
    assert.equal(result.isError, false);
    assert.equal(result.details.results[0].stderr, "");
    assert.doesNotMatch(result.content[0]?.text ?? "", /stale after session replacement/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_delegate preserves real stderr while suppressing benign stale ctx noise", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-delegate-real-stderr-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi-real-stderr.mjs");
  fs.writeFileSync(fakePiScript, `
    const stale = "Extension error (/tmp/ext.ts): This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
    console.error(stale);
    console.error("real warning");
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
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
    const result = await delegateTool.execute("call-real-stderr", { agent: "fixer", task: "Emit mixed stderr" }, undefined, undefined, { cwd: projectDir });
    assert.equal(result.isError, false);
    assert.equal(result.details.results[0].stderr, "real warning\n");
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
    assert.match(result.content[0]?.text ?? "", /simulated failure/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /Empty response from provider/);
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
