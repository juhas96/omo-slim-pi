import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

test("installer CLI scaffolds project-local Pantheon files and verify passes", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-installer-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const cliPath = path.resolve("bin/oh-my-opencode-pi.mjs");
  execFileSync(process.execPath, [cliPath, "install", "--cwd", projectDir, "--yes", "--reset", "--tmux=yes", "--skills=yes"], { encoding: "utf8" });
  execFileSync(process.execPath, [cliPath, "verify", "--cwd", projectDir], { encoding: "utf8" });

  const configPath = path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc");
  const configText = fs.readFileSync(configPath, "utf8");
  assert.match(configText, /"tmux": true/);
  assert.match(configText, /"karpathy-guidelines"/);
  assert.match(configText, /"cartography"/);
  assert.match(configText, /Pantheon inherits pi's default provider\/model/);
  assert.match(configText, /"defaultPreset": "review-board"/);
  assert.doesNotMatch(configText, /"oracle": \{[\s\S]*?"model":/);
  assert.doesNotMatch(configText, /"reviewer", "model":/);
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "pantheon-adapters", "README.md")));
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "agents", "README.md")));
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "prompts", "README.md")));
});
