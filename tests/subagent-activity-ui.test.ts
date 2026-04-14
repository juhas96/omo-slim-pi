import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

function registerHarness(commandMessages: Array<{ content?: string; details?: any }> = []) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const fakePi = {
    on() {},
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage(message: { content?: string; details?: any }) {
      commandMessages.push(message);
    },
    sendUserMessage() {},
    appendEntry() {},
  };
  extension(fakePi as never);
  return { tools, commands, commandMessages };
}

function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function findFirstFile(root: string, fileName: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const nested = findFirstFile(fullPath, fileName);
      if (nested) return nested;
    }
  }
  return undefined;
}

test("pantheon_delegate updates the subagent activity widget for parallel runs", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-subagent-widget-delegate-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "live:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const widgetCalls: Array<{ key: string; lines?: string[] }> = [];
    const { tools } = registerHarness();
    const delegateTool = tools.get("pantheon_delegate");
    await delegateTool.execute(
      "call-1",
      {
        tasks: [
          { agent: "explorer", task: "Analyze the repo" },
          { agent: "librarian", task: "Research the package" },
        ],
        includeProjectAgents: true,
      },
      undefined,
      undefined,
      {
        cwd: projectDir,
        ui: {
          theme: fakeTheme(),
          setWidget(key: string, lines?: string[]) {
            widgetCalls.push({ key, lines });
          },
          setEditorText() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    const activityCalls = widgetCalls.filter((call) => call.key === "oh-my-opencode-pi-subagent-activity" && Array.isArray(call.lines));
    assert.ok(activityCalls.length > 0);
    const combined = activityCalls.map((call) => call.lines?.join("\n") ?? "").join("\n\n");
    assert.match(combined, /explorer/);
    assert.match(combined, /librarian/);
    assert.match(combined, /live:Task:/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_delegate keeps live widget entries in running state until the process actually closes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-subagent-widget-running-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "slow-close-pi.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "live:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
    setTimeout(() => process.exit(0), 300);
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const widgetCalls: Array<{ key: string; lines?: string[] }> = [];
    const { tools } = registerHarness();
    const delegateTool = tools.get("pantheon_delegate");
    await delegateTool.execute(
      "call-running",
      { agent: "fixer", task: "Wait for process close" },
      undefined,
      undefined,
      {
        cwd: projectDir,
        ui: {
          theme: fakeTheme(),
          setWidget(key: string, lines?: string[]) {
            widgetCalls.push({ key, lines });
          },
          setEditorText() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    const activityLines = widgetCalls
      .filter((call) => call.key === "oh-my-opencode-pi-subagent-activity" && Array.isArray(call.lines))
      .map((call) => call.lines?.join("\n") ?? "");
    assert.ok(activityLines.some((text) => text.includes("… fixer — Implementation specialist · live:Task:")));
    assert.ok(activityLines.some((text) => text.includes("✓ fixer — Implementation specialist · live:Task:")));
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon_council updates the subagent activity widget while councillors and master run", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-subagent-widget-council-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "live:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const widgetCalls: Array<{ key: string; lines?: string[] }> = [];
    const { tools } = registerHarness();
    const councilTool = tools.get("pantheon_council");
    await councilTool.execute(
      "call-2",
      { prompt: "Should we proceed?", preset: "quick" },
      undefined,
      undefined,
      {
        cwd: projectDir,
        ui: {
          theme: fakeTheme(),
          setWidget(key: string, lines?: string[]) {
            widgetCalls.push({ key, lines });
          },
          setEditorText() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    const activityCalls = widgetCalls.filter((call) => call.key === "oh-my-opencode-pi-subagent-activity" && Array.isArray(call.lines));
    assert.ok(activityCalls.length > 0);
    const combined = activityCalls.map((call) => call.lines?.join("\n") ?? "").join("\n\n");
    assert.match(combined, /council quick/);
    assert.match(combined, /master/);
    assert.match(combined, /live:Task:/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon-subagents opens per-agent details and can jump to the full trace", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-subagent-widget-details-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "live:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const { tools, commands } = registerHarness(commandMessages);
    const delegateTool = tools.get("pantheon_delegate");
    const pantheonSubagents = commands.get("pantheon-subagents");
    assert.ok(delegateTool?.execute);
    assert.ok(pantheonSubagents?.handler);

    const editorWrites: string[] = [];
    await delegateTool.execute(
      "call-3",
      { tasks: [{ agent: "explorer", task: "Analyze the repo" }], includeProjectAgents: true },
      undefined,
      undefined,
      {
        cwd: projectDir,
        ui: {
          theme: fakeTheme(),
          setWidget() {},
          setEditorText() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    const debugDir = path.join(projectDir, ".oh-my-opencode-pi-debug");
    const stdoutPath = findFirstFile(debugDir, "stdout.ndjson");
    assert.ok(stdoutPath);
    const streamedOutput = [
      ...Array.from({ length: 2500 }, (_, index) => JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: `chunk-${index} ` },
      })),
      JSON.stringify({
        type: "tool_result_end",
        message: {
          role: "tool",
          content: [{ type: "text", text: "tool-progress: checked key files" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final subagent answer" }],
          model: "fake/model",
          stopReason: "end_turn",
        },
      }),
    ].join("\n");
    fs.writeFileSync(stdoutPath!, streamedOutput, "utf8");

    await pantheonSubagents.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        theme: fakeTheme(),
        custom: async () => ({ action: "details", index: 0 }),
        setWidget() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        notify() {},
        setStatus() {},
        input: async () => "",
      },
    });
    assert.match(editorWrites[0] ?? "", /Subagent: explorer/);
    assert.match(editorWrites[0] ?? "", /Output:/);
    assert.match(editorWrites[0] ?? "", /truncated: showing last/i);
    assert.doesNotMatch(editorWrites[0] ?? "", /"type":"content_block_delta"/);
    assert.ok((editorWrites[0] ?? "").length < 80_000);

    await pantheonSubagents.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        theme: fakeTheme(),
        custom: async () => ({ action: "stdout", index: 0 }),
        setWidget() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        notify() {},
        setStatus() {},
        input: async () => "",
      },
    });
    assert.match(editorWrites[1] ?? "", /Artifact: Output/);
    assert.match(editorWrites[1] ?? "", /tool-progress: checked key files/);
    assert.doesNotMatch(editorWrites[1] ?? "", /"message_end"/);

    await pantheonSubagents.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        theme: fakeTheme(),
        custom: async () => ({ action: "paths", index: 0 }),
        setWidget() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        notify() {},
        setStatus() {},
        input: async () => "",
      },
    });
    assert.match(editorWrites[2] ?? "", /Debug dir:/);
    assert.match(editorWrites[2] ?? "", /Stdout:/);

    await pantheonSubagents.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        theme: fakeTheme(),
        custom: async () => ({ action: "trace", index: 0 }),
        setWidget() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        notify() {},
        setStatus() {},
        input: async () => "",
      },
    });
    assert.match(editorWrites[3] ?? "", /Command: \/pantheon-debug/);
    assert.match(editorWrites[3] ?? "", /Trace:/);
    assert.equal(commandMessages.length, 0);
  } finally {
    process.argv[1] = originalArgv1;
  }
});

test("pantheon-debug keeps direct trace inspection out of chat", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-subagent-widget-direct-debug-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePiScript = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePiScript, `
    const task = process.argv[process.argv.length - 1] || "";
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "live:" + task.slice(0, 40) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePiScript;
  try {
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const { tools, commands } = registerHarness(commandMessages);
    const delegateTool = tools.get("pantheon_delegate");
    const pantheonDebug = commands.get("pantheon-debug");
    assert.ok(delegateTool?.execute);
    assert.ok(pantheonDebug?.handler);

    await delegateTool.execute(
      "call-debug",
      { tasks: [{ agent: "explorer", task: "Analyze the repo" }], includeProjectAgents: true },
      undefined,
      undefined,
      {
        cwd: projectDir,
        ui: {
          theme: fakeTheme(),
          setWidget() {},
          setEditorText() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    let editorText = "";
    await pantheonDebug.handler("", {
      cwd: projectDir,
      hasUI: false,
      ui: {
        theme: fakeTheme(),
        custom: async () => null,
        setWidget() {},
        setEditorText(text: string) {
          editorText = text;
        },
        notify() {},
        setStatus() {},
        input: async () => "",
      },
    });

    assert.match(editorText, /Command: \/pantheon-debug/);
    assert.equal(commandMessages.length, 0);
  } finally {
    process.argv[1] = originalArgv1;
  }
});
