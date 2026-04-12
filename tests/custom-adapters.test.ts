import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("custom adapter modules are discovered, listed, and executable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-custom-adapter-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const modulePath = path.join(agentDir, "custom-docs.mjs");
  fs.writeFileSync(modulePath, `
    export default {
      id: "custom-docs",
      label: "Custom Docs",
      description: "Custom adapter from test module",
      async search(params) {
        return { text: "search:" + (params.query || "") };
      },
      async fetch(params, ctx) {
        return { text: ctx.helpers.previewText("fetched:" + (params.query || params.topic || ""), 100) };
      }
    };
  `);

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    adapters: {
      modules: [modulePath],
      defaultAllow: ["custom-docs"],
    },
  }, null, 2));

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
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

    const listTool = tools.get("pantheon_adapter_list");
    const listResult = await listTool.execute("call-1", {}, undefined, undefined, { cwd: projectDir });
    const listText = listResult.content[0]?.text ?? "";
    assert.match(listText, /custom-docs/);

    const fetchTool = tools.get("pantheon_adapter_fetch");
    const fetchResult = await fetchTool.execute("call-2", { adapter: "custom-docs", query: "hello" }, undefined, undefined, { cwd: projectDir });
    const fetchText = fetchResult.content[0]?.text ?? "";
    assert.match(fetchText, /fetched:hello/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
