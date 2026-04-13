import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

test("commands, tools, and prompt hooks stay inert when Pantheon is disabled", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-disabled-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "enabled": false,
    "background": { "enabled": false }
  }`);

  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const fakePi = {
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  };

  extension(fakePi as never);

  const notifications: Array<{ text: string; level: string }> = [];
  const ctx = {
    cwd: projectDir,
    hasUI: true,
    model: { provider: "openai" },
    sessionManager: { getEntries: () => [] },
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
      setStatus() {},
      setWidget() {},
      setEditorText() {},
      theme: {},
    },
  };

  await commands.get("pantheon-stats").handler("", ctx as never);
  assert.match(notifications[0]?.text ?? "", /disabled in config/i);

  const toolResult = await tools.get("pantheon_stats").execute("call-1", {}, undefined, undefined, { cwd: projectDir });
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content[0]?.text ?? "", /disabled in config/i);

  const beforeAgentStart = handlers.get("before_agent_start");
  const injected = await beforeAgentStart({ systemPrompt: "base prompt", prompt: "help", images: [] }, ctx as never);
  assert.equal(injected, undefined);
});
