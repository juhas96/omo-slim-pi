import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPantheonConfig } from "../extensions/oh-my-opencode-pi/config.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("loadPantheonConfig supports JSONC, presets, deep merge, and agent prompt file resolution", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-config-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

  const globalPrompt = path.join(agentDir, "fixer-global.md");
  const projectPrompt = path.join(projectDir, ".pi", "explorer-project.md");
  fs.writeFileSync(globalPrompt, "Global fixer guidance\n");
  fs.writeFileSync(projectPrompt, "Project explorer guidance\n");

  const customAdapterModule = path.join(agentDir, "mock-adapter.mjs");
  fs.writeFileSync(customAdapterModule, "export default { id: 'mock-adapter', label: 'Mock Adapter', description: 'test adapter', async fetch() { return 'ok'; } };\n");

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.jsonc"), `{
    // JSONC support
    "preset": "fast",
    "background": { "reuseSessions": true, "heartbeatIntervalMs": 900, "staleAfterMs": 12000 },
    "fallback": { "finalMessageGraceMs": 2200 },
    "skills": {
      "defaultAllow": ["cartography"],
      "cartography": { "enabled": true, "maxFiles": 120 }
    },
    "adapters": {
      "defaultAllow": ["docs-context7"],
      "disabled": ["github-releases"],
      "modules": ["./mock-adapter.mjs"]
    },
    "agents": {
      "fixer": {
        "model": "openai/gpt-4.1",
        "variant": "high",
        "options": ["--model", "openai/gpt-4.1"],
        "promptOverrideFile": "./fixer-global.md",
        "allowedAdapters": ["web-search"]
      }
    }
  }`);

  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "extends": ["durable"],
    "research": { "maxResults": 9 },
    "updates": { "notify": false, "checkIntervalHours": 12 },
    "multiplexer": { "projectScopedWindow": false },
    "agents": {
      "explorer": {
        "promptAppendFiles": ["./explorer-project.md"],
        "promptAppendText": "Prefer repository reconnaissance first.",
        "allowSkills": ["cartography"]
      }
    }
  }`);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const result = loadPantheonConfig(projectDir);
    assert.equal(result.sources.globalPath, path.join(agentDir, "oh-my-opencode-pi.jsonc"));
    assert.equal(result.sources.projectPath, path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"));
    assert.deepEqual(result.activePresets.sort(), ["durable", "fast"]);
    assert.equal(result.config.background?.maxConcurrent, 1);
    assert.equal(result.config.background?.reuseSessions, true);
    assert.equal(result.config.background?.heartbeatIntervalMs, 900);
    assert.equal(result.config.background?.staleAfterMs, 12000);
    assert.equal(result.config.fallback?.retryOnEmpty, true);
    assert.equal(result.config.fallback?.finalMessageGraceMs, 2200);
    assert.equal(result.config.research?.maxResults, 9);
    assert.equal(result.config.updates?.notify, false);
    assert.equal(result.config.updates?.checkIntervalHours, 12);
    assert.equal(result.config.agents?.fixer?.model, "openai/gpt-4.1");
    assert.equal(result.config.agents?.fixer?.variant, "high");
    assert.equal(result.config.agents?.fixer?.promptOverrideFile, globalPrompt);
    assert.deepEqual(result.config.agents?.fixer?.allowedAdapters, ["web-search"]);
    assert.deepEqual(result.config.agents?.explorer?.promptAppendFiles, [projectPrompt]);
    assert.deepEqual(result.config.agents?.explorer?.allowSkills, ["cartography"]);
    assert.match(result.config.agents?.explorer?.promptAppendText ?? "", /repository reconnaissance/i);
    assert.equal(result.config.skills?.cartography?.maxFiles, 120);
    assert.deepEqual(result.config.adapters?.defaultAllow, ["docs-context7"]);
    assert.deepEqual(result.config.adapters?.disabled, ["github-releases"]);
    assert.deepEqual(result.config.adapters?.modules, [customAdapterModule]);
    assert.equal(result.config.multiplexer?.projectScopedWindow, false);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.diagnostics.length, 0);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("project config can re-enable Pantheon after a global disable", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-config-reenable-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.jsonc"), `{
    "enabled": false,
    "background": { "enabled": false }
  }`);
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "enabled": true,
    "background": { "enabled": true }
  }`);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const result = loadPantheonConfig(projectDir);
    assert.equal(result.config.enabled, true);
    assert.equal(result.config.background?.enabled, true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.diagnostics.length, 0);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("loadPantheonConfig surfaces schema and lint diagnostics for invalid config entries", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-config-invalid-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "$schema": "../missing-schema.json",
    "mystery": true,
    "multiplexer": { "layout": "zigzag" },
    "adapters": {
      "defaultAllow": ["unknown-adapter"],
      "modules": ["./missing-adapter.mjs"]
    },
    "agents": {
      "fixer": {
        "promptOverrideFile": "./missing-prompt.md",
        "unknownAgentSetting": true
      }
    }
  }`);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const result = loadPantheonConfig(projectDir);
    assert.ok(result.diagnostics.length >= 5);
    const text = result.warnings.join("\n");
    assert.match(text, /Unknown config key/);
    assert.match(text, /Expected one of: tiled, even-horizontal, even-vertical, main-horizontal, main-vertical/);
    assert.match(text, /Unknown adapter id 'unknown-adapter'/);
    assert.match(text, /Module not found/);
    assert.match(text, /File not found/);
    assert.match(text, /Schema not found/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
