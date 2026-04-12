import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renameSymbol } from "../extensions/oh-my-opencode-pi/tools/lsp.ts";
import { astGrepReplace } from "../extensions/oh-my-opencode-pi/tools/ast-grep.ts";

test("renameSymbol can apply coordinated TS rename edits", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-rename-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["**/*.ts"],
  }, null, 2));
  const filePath = path.join(projectDir, "index.ts");
  fs.writeFileSync(filePath, "const oldName = 1;\nconsole.log(oldName);\n");

  const result = renameSymbol(projectDir, { path: filePath, line: 1, character: 7, newName: "newName", apply: true });
  assert.match(result.text, /Applied rename/);
  assert.match(fs.readFileSync(filePath, "utf8"), /newName/);
});

test("astGrepReplace can apply structural rewrites", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-ast-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "demo.ts");
  fs.writeFileSync(filePath, "const value = foo(bar);\n");

  const result = astGrepReplace(projectDir, {
    path: filePath,
    lang: "ts",
    pattern: "foo($A)",
    rewrite: "baz($A)",
    apply: true,
  });
  assert.equal(result.applied, true);
  assert.match(fs.readFileSync(filePath, "utf8"), /baz\(bar\)/);
});
