import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";
import { auditPantheonProviderConfiguration } from "../extensions/oh-my-opencode-pi/doctor.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function registerCommands(commandMessages: Array<{ content?: string; details?: any }> = []) {
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
    sendUserMessage() {},
    appendEntry() {},
  };
  extension(fakePi as never);
  return commands;
}

test("provider audit warns when explicit Pantheon model providers do not match available pi auth", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-doctor-provider-audit-"));
  const agentDir = path.join(tempRoot, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex" }, null, 2));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }, null, 2));

  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";
  try {
    const audit = auditPantheonProviderConfiguration({
      agents: { oracle: { model: "openai/gpt-5.4" } },
      council: {
        presets: {
          "review-board": {
            councillors: [{ name: "reviewer", model: "openai/gpt-5.4" }],
          },
        },
      },
    } as never, agentDir);

    assert.deepEqual(audit.authenticatedProviders, ["openai-codex"]);
    assert.equal(audit.explicitModels[0]?.provider, "openai");
    assert.match(audit.warnings.join("\n"), /provider 'openai'/);
    assert.match(audit.warnings.join("\n"), /openai-codex/);
    assert.match(audit.warnings.join("\n"), /agents\.oracle\.model=openai\/gpt-5\.4/);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("provider audit accepts env-authenticated API key providers", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-doctor-provider-env-"));
  const agentDir = path.join(tempRoot, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex" }, null, 2));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }, null, 2));

  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const audit = auditPantheonProviderConfiguration({
      agents: { oracle: { model: "openai/gpt-5.4" } },
    } as never, agentDir);

    assert.ok(audit.authenticatedProviders.includes("openai"));
    assert.equal(audit.warnings.length, 0);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("pantheon-doctor surfaces provider mismatch warnings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-doctor-provider-command-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex" }, null, 2));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }, null, 2));
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), JSON.stringify({
    agents: {
      oracle: { model: "openai/gpt-5.4" },
    },
  }, null, 2));

  const previousAgentDir = process.env[AGENT_DIR_ENV];
  const previousKey = process.env.OPENAI_API_KEY;
  process.env[AGENT_DIR_ENV] = agentDir;
  process.env.OPENAI_API_KEY = "";
  try {
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const commands = registerCommands(commandMessages);
    const doctorCommand = commands.get("pantheon-doctor");
    const editorWrites: string[] = [];

    await doctorCommand.handler("", {
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

    const text = editorWrites.at(-1) ?? commandMessages.at(-1)?.content ?? "";
    assert.match(text, /Provider auth:/);
    assert.match(text, /Provider warnings:/);
    assert.match(text, /provider 'openai'/);
    assert.match(text, /openai-codex/);
    assert.match(text, /agents\.oracle\.model=openai\/gpt-5\.4/);
  } finally {
    if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previousAgentDir;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
