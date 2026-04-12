import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

function registerHarness() {
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
    sendUserMessage() {},
    appendEntry() {},
  };
  extension(fakePi as never);
  return { tools, commands };
}

function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
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
    const { tools, commands } = registerHarness();
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

    let customCalls = 0;
    await pantheonSubagents.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        theme: fakeTheme(),
        custom: async () => (++customCalls === 1 ? "0" : "details"),
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
    assert.match(editorWrites[0] ?? "", /Stdout:/);

    customCalls = 0;
    await pantheonSubagents.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        theme: fakeTheme(),
        custom: async () => (++customCalls === 1 ? "0" : "trace"),
        setWidget() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        notify() {},
        setStatus() {},
        input: async () => "",
      },
    });
    assert.match(editorWrites[1] ?? "", /Trace:/);
  } finally {
    process.argv[1] = originalArgv1;
  }
});
