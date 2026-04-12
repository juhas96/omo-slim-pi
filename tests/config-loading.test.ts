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

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.jsonc"), `{
    // JSONC support
    "preset": "fast",
    "skills": {
      "defaultAllow": ["cartography"],
      "cartography": { "enabled": true, "maxFiles": 120 }
    },
    "adapters": {
      "defaultAllow": ["docs-context7"],
      "disabled": ["github-releases"]
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
    assert.equal(result.config.fallback?.retryOnEmpty, true);
    assert.equal(result.config.research?.maxResults, 9);
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
    assert.equal(result.warnings.length, 0);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
