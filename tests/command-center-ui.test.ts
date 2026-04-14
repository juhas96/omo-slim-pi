import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

function registerCommands(sentMessages: string[], commandMessages: Array<{ content?: string; details?: any }> = []) {
  const commands = new Map<string, any>();
  const fakePi = {
    on() {},
    registerTool() {},
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage(message: { content?: string; details?: any }) {
      commandMessages.push(message);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
    appendEntry() {},
  };
  extension(fakePi as never);
  return commands;
}

test("review command sends a structured prompt for uncommitted changes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-review-uncommitted-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sentMessages: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const commands = registerCommands(sentMessages);
  const reviewCommand = commands.get("review");
  assert.ok(reviewCommand?.handler);

  await reviewCommand.handler("uncommitted", {
    cwd: projectDir,
    hasUI: false,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setEditorText() {},
      setStatus() {},
      setWidget() {},
      input: async () => "",
      custom: async () => null,
    },
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0] ?? "", /obra\/superpowers/i);
  assert.match(sentMessages[0] ?? "", /git --no-pager diff --cached/);
  assert.match(sentMessages[0] ?? "", /### Strengths/);
  assert.match(sentMessages[0] ?? "", /Ready to merge\?/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /Queued review prompt for uncommitted local changes/);
});

test("review command can build a committed review prompt interactively", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-review-committed-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sentMessages: string[] = [];
  const commands = registerCommands(sentMessages);
  const reviewCommand = commands.get("review");
  assert.ok(reviewCommand?.handler);

  await reviewCommand.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      custom: async () => "committed",
      input: async () => "HEAD~3..HEAD",
      notify() {},
      setEditorText() {},
      setStatus() {},
      setWidget() {},
    },
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0] ?? "", /Mode: committed/);
  assert.match(sentMessages[0] ?? "", /Target: HEAD~3\.\.HEAD/);
  assert.match(sentMessages[0] ?? "", /git --no-pager diff --stat 'HEAD~3\.\.HEAD'/);
});

test("review command rejects unsupported review modes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-review-invalid-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sentMessages: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const commands = registerCommands(sentMessages);
  const reviewCommand = commands.get("review");
  assert.ok(reviewCommand?.handler);

  await reviewCommand.handler("branch main", {
    cwd: projectDir,
    hasUI: false,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setEditorText() {},
      setStatus() {},
      setWidget() {},
      input: async () => "",
      custom: async () => null,
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "error");
  assert.match(notifications[0]?.message ?? "", /Usage: \/review/);
});

test("pantheon-agents posts a specialist guide to the editor/widget surfaces", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-agents-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const commands = registerCommands(sentMessages, commandMessages);
  const pantheonAgents = commands.get("pantheon-agents");
  assert.ok(pantheonAgents?.handler);

  const editorWrites: string[] = [];
  const widgetWrites: string[][] = [];
  let customCalls = 0;
  await pantheonAgents.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setEditorText(text: string) {
        editorWrites.push(text);
      },
      setStatus() {},
      setWidget(_key: string, lines?: string[]) {
        if (Array.isArray(lines)) widgetWrites.push(lines);
      },
      input: async () => "",
      custom: async () => {
        customCalls += 1;
        return null;
      },
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(editorWrites.length, 0);
  assert.equal(commandMessages.length, 0);
  assert.equal(customCalls, 1);
  assert.ok(widgetWrites.length > 0);
  assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /\/pantheon-agents/);
  assert.equal(notifications.at(-1)?.message, "Opened Pantheon specialist guide.");
});

test("pantheon command center routes advanced actions through a secondary menu without injecting slash commands into chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-center-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sentMessages: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const commands = registerCommands(sentMessages);

  const pantheonCommand = commands.get("pantheon");
  assert.ok(pantheonCommand?.handler);

  let customCalls = 0;
  await pantheonCommand.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      custom: async () => (++customCalls === 1 ? "advanced" : "adapter-health"),
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setEditorText() {},
      setStatus() {},
      setWidget() {},
      input: async () => "",
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(customCalls, 2);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /docs-context7 \[ok\] auth=not-required/);
});

test("pantheon council command executes natively without injecting prompt text into chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-council-"));
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
    const sentMessages: string[] = [];
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const commands = registerCommands(sentMessages, commandMessages);
    const pantheonCouncil = commands.get("pantheon-council");
    assert.ok(pantheonCouncil?.handler);

    const editorWrites: string[] = [];
    const widgetWrites: string[][] = [];
    let customCall = 0;
    await pantheonCouncil.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        custom: async () => (++customCall === 1 ? "quick" : null),
        input: async () => "Should we proceed?",
        notify() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        setStatus() {},
        setWidget(_key: string, lines?: string[]) {
          if (Array.isArray(lines)) widgetWrites.push(lines);
        },
      },
    });

    assert.equal(sentMessages.length, 0);
    assert.equal(editorWrites.length, 1);
    assert.match(editorWrites[0] ?? "", /Command: \/pantheon-council/);
    assert.equal(commandMessages.length, 1);
    assert.match(commandMessages[0]?.content ?? "", /Pantheon command output/);
    assert.match(commandMessages[0]?.content ?? "", /Command: \/pantheon-council/);
    assert.match(commandMessages[0]?.content ?? "", /Council preset: quick/);
    assert.equal(commandMessages[0]?.details?.status, "success");
    assert.ok(widgetWrites.length > 0);
    assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /\/pantheon-council/);
    assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /✓ ready/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon-as executes delegate natively without posting the result into chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-as-"));
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
    const sentMessages: string[] = [];
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const commands = registerCommands(sentMessages, commandMessages);
    const pantheonAs = commands.get("pantheon-as");
    assert.ok(pantheonAs?.handler);

    const editorWrites: string[] = [];
    const widgetWrites: string[][] = [];
    await pantheonAs.handler("fixer Implement a tiny change", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        notify() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        setStatus() {},
        setWidget(_key: string, lines?: string[]) {
          if (Array.isArray(lines)) widgetWrites.push(lines);
        },
        input: async () => "",
        custom: async () => null,
      },
    });

    assert.equal(sentMessages.length, 0);
    assert.equal(editorWrites.length, 1);
    assert.match(editorWrites[0] ?? "", /Command: \/pantheon-as/);
    assert.equal(commandMessages.length, 0);
    assert.ok(widgetWrites.length > 0);
    assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /\/pantheon-as/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon-hooks keeps labeled command output out of chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-hooks-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  const commands = registerCommands(sentMessages, commandMessages);
  const pantheonHooks = commands.get("pantheon-hooks");
  assert.ok(pantheonHooks?.handler);

  const editorWrites: string[] = [];
  const widgetWrites: string[][] = [];
  await pantheonHooks.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      notify() {},
      setEditorText(text: string) {
        editorWrites.push(text);
      },
      setStatus() {},
      setWidget(_key: string, lines?: string[]) {
        if (Array.isArray(lines)) widgetWrites.push(lines);
      },
      input: async () => "",
      custom: async () => null,
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(editorWrites.length, 1);
  assert.match(editorWrites[0] ?? "", /Command: \/pantheon-hooks/);
  assert.equal(commandMessages.length, 0);
  assert.ok(widgetWrites.length > 0);
  assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /\/pantheon-hooks/);
  assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /✓ ready/);
});

test("pantheon-config keeps the structured config report out of chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-config-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "background": { "maxConcurrent": 2 },
    "adapters": { "defaultAllow": ["docs-context7"] }
  }`);

  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  const commands = registerCommands(sentMessages, commandMessages);
  const pantheonConfig = commands.get("pantheon-config");
  assert.ok(pantheonConfig?.handler);

  const editorWrites: string[] = [];
  const widgetWrites: string[][] = [];
  let customCalls = 0;
  await pantheonConfig.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      notify() {},
      setEditorText(text: string) {
        editorWrites.push(text);
      },
      setStatus() {},
      setWidget(_key: string, lines?: string[]) {
        if (Array.isArray(lines)) widgetWrites.push(lines);
      },
      input: async () => "",
      custom: async () => {
        customCalls++;
        return null;
      },
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(editorWrites.length, 1);
  assert.match(editorWrites[0] ?? "", /Command: \/pantheon-config/);
  assert.equal(commandMessages.length, 0);
  assert.ok(widgetWrites.length > 0);
  assert.match(widgetWrites.at(-1)?.join("\n") ?? "", /\/pantheon-config/);
  assert.equal(customCalls, 1);
});

test("pantheon-adapters keeps the adapter policy report out of chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-adapters-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "adapters": { "defaultAllow": ["docs-context7", "npm-registry"] }
  }`);

  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  const commands = registerCommands(sentMessages, commandMessages);
  const pantheonAdapters = commands.get("pantheon-adapters");
  assert.ok(pantheonAdapters?.handler);

  const editorWrites: string[] = [];
  await pantheonAdapters.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      notify() {},
      setEditorText(text: string) {
        editorWrites.push(text);
      },
      setStatus() {},
      setWidget() {},
      input: async () => "",
      custom: async () => null,
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(editorWrites.length, 1);
  assert.match(editorWrites[0] ?? "", /Command: \/pantheon-adapters/);
  assert.equal(commandMessages.length, 0);
});

test("pantheon-doctor keeps the health report in editor/widget surfaces", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-doctor-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "$schema": "../missing-schema.json",
    "mystery": true
  }`);

  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  const commands = registerCommands(sentMessages, commandMessages);
  const pantheonDoctor = commands.get("pantheon-doctor");
  assert.ok(pantheonDoctor?.handler);

  const editorWrites: string[] = [];
  const widgetWrites: string[][] = [];
  await pantheonDoctor.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      notify() {},
      setEditorText(text: string) {
        editorWrites.push(text);
      },
      setStatus() {},
      setWidget(_key: string, lines?: string[]) {
        if (Array.isArray(lines)) widgetWrites.push(lines);
      },
      input: async () => "",
      custom: async () => null,
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(editorWrites.length, 1);
  assert.match(editorWrites[0] ?? "", /Command: \/pantheon-doctor/);
  assert.equal(commandMessages.length, 0);
  assert.ok(widgetWrites.length > 0);
});

test("pantheon-task-actions routes task actions through an interactive menu", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-task-actions-"));
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), JSON.stringify({
    background: { logDir: taskDir },
  }, null, 2));

  const resultPath = path.join(taskDir, "task-1.result.json");
  const logPath = path.join(taskDir, "task-1.log");
  fs.writeFileSync(logPath, "hello\nworld\n");
  fs.writeFileSync(resultPath, JSON.stringify({
    id: "task-1",
    agent: "fixer",
    task: "Do the thing",
    status: "completed",
    createdAt: 1,
    startedAt: 2,
    finishedAt: 4,
    summary: "task done",
    logPath,
    resultPath,
    result: {
      agent: "fixer",
      agentSource: "bundled",
      task: "Do the thing",
      exitCode: 0,
      messages: [{ role: "assistant", content: [{ type: "text", text: "all done" }] }],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
      durationMs: 2,
    },
  }, null, 2));

  const sentMessages: string[] = [];
  const commandMessages: Array<{ content?: string; details?: any }> = [];
  const commands = registerCommands(sentMessages, commandMessages);
  const taskActions = commands.get("pantheon-task-actions");
  assert.ok(taskActions?.handler);

  const editorWrites: string[] = [];
  let customCalls = 0;
  await taskActions.handler("", {
    cwd: projectDir,
    hasUI: true,
    ui: {
      custom: async () => (++customCalls === 1 ? "task-1" : "result"),
      notify() {},
      setEditorText(text: string) {
        editorWrites.push(text);
      },
      setStatus() {},
      setWidget() {},
      input: async () => "",
    },
  });

  assert.equal(sentMessages.length, 0);
  assert.equal(editorWrites.length, 1);
  assert.match(editorWrites[0] ?? "", /Command: \/pantheon-result/);
  assert.equal(commandMessages.length, 0);
});

test("pantheon-as streams partial command output in widgets before keeping the final result in editor/widget surfaces", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-command-as-streaming-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const fakePiScript = path.join(tempRoot, "fake-pi-streaming.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    setTimeout(() => {
      console.log(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial:" + task.slice(0, 20) }],
          model: "fake/model",
          stopReason: "end_turn"
        }
      }));
    }, 10);
    setTimeout(() => {
      console.log(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final:" + task.slice(0, 20) }],
          model: "fake/model",
          stopReason: "end_turn"
        }
      }));
    }, 30);
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const sentMessages: string[] = [];
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const commands = registerCommands(sentMessages, commandMessages);
    const pantheonAs = commands.get("pantheon-as");
    assert.ok(pantheonAs?.handler);

    const editorWrites: string[] = [];
    const widgetWrites: string[][] = [];
    await pantheonAs.handler("fixer Stream a tiny change", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        notify() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        setStatus() {},
        setWidget(_key: string, lines?: string[]) {
          if (Array.isArray(lines)) widgetWrites.push(lines);
        },
        input: async () => "",
        custom: async () => null,
      },
    });

    assert.equal(sentMessages.length, 0);
    assert.equal(editorWrites.length, 1);
    assert.match(editorWrites[0] ?? "", /Command: \/pantheon-as/);
    assert.match(editorWrites[0] ?? "", /final:/i);
    assert.equal(commandMessages.length, 0);
    assert.ok(widgetWrites.some((lines) => /… running/.test(lines.join("\n")) && /partial:/i.test(lines.join("\n"))));
  } finally {
    process.argv[1] = originalArgv1;
  }
});
