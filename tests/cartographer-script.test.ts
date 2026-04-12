import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const cartographerModuleUrl = pathToFileURL(path.join(process.cwd(), "skills", "cartography", "scripts", "cartographer.mjs")).href;

test("cartographer script initializes state, reports changes, and updates snapshots", async () => {
  const mod = await import(cartographerModuleUrl);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-cartographer-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".gitignore"), "ignored.ts\n");
  fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Project notes\n\nExisting guidance.\n");
  fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(projectDir, "tests", "index.test.ts"), "test('x', () => {});\n");
  fs.writeFileSync(path.join(projectDir, "ignored.ts"), "export const ignored = true;\n");

  const init = mod.initCartography(projectDir, {
    include: ["src/**/*.ts", "package.json"],
    exclude: ["tests/**", "**/*.test.*"],
  });
  assert.equal(init.filesSelected, 1);
  assert.ok(fs.existsSync(path.join(projectDir, ".pi", "cartography.json")));
  assert.ok(fs.existsSync(path.join(projectDir, "codemap.md")));
  assert.ok(fs.existsSync(path.join(projectDir, "src", "codemap.md")));
  assert.ok(!fs.existsSync(path.join(projectDir, "tests", "codemap.md")));

  const rootCodemap = fs.readFileSync(path.join(projectDir, "codemap.md"), "utf8");
  assert.match(rootCodemap, /# Repository Atlas: project/);
  assert.match(rootCodemap, /## System Entry Points/);
  assert.match(rootCodemap, /\| `src\/` \| TODO: summarize this directory's responsibility\./);

  const agentsAfterInit = fs.readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
  assert.match(agentsAfterInit, /Existing guidance\./);
  assert.match(agentsAfterInit, /## Repository Map/);
  assert.equal((agentsAfterInit.match(/^## Repository Map$/gm) ?? []).length, 1);

  fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "export const value = 2;\n");
  fs.writeFileSync(path.join(projectDir, "src", "extra.ts"), "export const extra = true;\n");

  const changes = mod.detectCartographyChanges(projectDir);
  assert.equal(changes.hasChanges, true);
  assert.deepEqual(changes.added, ["src/extra.ts"]);
  assert.deepEqual(changes.modified, ["src/index.ts"]);
  assert.ok(changes.affectedFolders.includes("."));
  assert.ok(changes.affectedFolders.includes("src"));

  const messages = [] as string[];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const initExit = mod.main(["init", "--root", projectDir, "--include", "src/**/*.ts", "--exclude", "tests/**", "--exclude", "**/*.test.*"]);
    assert.equal(initExit, 0);
    const formatted = mod.main(["changes", "--root", projectDir]);
    assert.equal(formatted, 0);
  } finally {
    console.log = originalLog;
  }
  assert.match(messages.join("\n"), /Cartography initialized for/);
  assert.match(messages.join("\n"), /State file: \.pi\/cartography\.json/);
  assert.match(messages.join("\n"), /Root atlas: kept existing \(codemap\.md\)|Root atlas: created \(codemap\.md\)/);
  assert.match(messages.join("\n"), /AGENTS\.md repository map: ensured|AGENTS\.md repository map: already present/);

  const updated = mod.updateCartographyState(projectDir);
  assert.equal(updated.filesSelected, 2);
  const after = mod.detectCartographyChanges(projectDir);
  assert.equal(after.hasChanges, false);

  const updateMessages = [] as string[];
  console.log = (...args: unknown[]) => {
    updateMessages.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const updateExit = mod.main(["update", "--root", projectDir]);
    assert.equal(updateExit, 0);
  } finally {
    console.log = originalLog;
  }
  assert.match(updateMessages.join("\n"), /Cartography state updated for/);
  assert.match(updateMessages.join("\n"), /Folders tracked: 2/);

  const agentsAfterUpdate = fs.readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
  assert.equal((agentsAfterUpdate.match(/^## Repository Map$/gm) ?? []).length, 1);
});
