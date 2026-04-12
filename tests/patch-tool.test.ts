import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyUnifiedPatch } from "../extensions/oh-my-opencode-pi/tools/patch.ts";

test("applyUnifiedPatch tolerantly applies a moved hunk", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-patch-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "demo.ts");

  fs.writeFileSync(filePath, [
    "// banner added after patch creation",
    "function demo() {",
    "  const value = 1;   ",
    "  return value;",
    "}",
    "",
  ].join("\n"));

  const patch = [
    "--- a/demo.ts",
    "+++ b/demo.ts",
    "@@ -1,4 +1,4 @@",
    " function demo() {",
    "-  const value = 1;",
    "+  const value = 2;",
    "   return value;",
    " }",
    "",
  ].join("\n");

  const preview = applyUnifiedPatch(projectDir, { patch, apply: false });
  assert.equal(preview.applied, false);
  assert.match(preview.text, /Prepared unified patch/);
  assert.match(preview.text, /\+1\/-1/);

  const applied = applyUnifiedPatch(projectDir, { patch, apply: true });
  assert.equal(applied.applied, true);
  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /const value = 2;/);
});

test("applyUnifiedPatch supports create, delete, rename, and multi-file updates", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-patch-ops-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const renamedOld = path.join(projectDir, "old-name.ts");
  const deletedPath = path.join(projectDir, "remove-me.txt");
  const updatedPath = path.join(projectDir, "keep.ts");
  fs.writeFileSync(renamedOld, "export const value = 1;\n");
  fs.writeFileSync(deletedPath, "delete me\n");
  fs.writeFileSync(updatedPath, "export function keep() {\n  return 1;\n}\n");

  const patch = [
    "--- /dev/null",
    "+++ b/new-file.ts",
    "@@ -0,0 +1,2 @@",
    "+export const created = true;",
    "+",
    "--- a/remove-me.txt",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-delete me",
    "--- a/old-name.ts",
    "+++ b/new-name.ts",
    "@@ -1,1 +1,1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    "--- a/keep.ts",
    "+++ b/keep.ts",
    "@@ -1,3 +1,4 @@",
    " export function keep() {",
    "-  return 1;",
    "+  const next = 2;",
    "+  return next;",
    " }",
    "",
  ].join("\n");

  const result = applyUnifiedPatch(projectDir, { patch, apply: true });
  assert.equal(result.files.length, 4);
  assert.ok(fs.existsSync(path.join(projectDir, "new-file.ts")));
  assert.ok(!fs.existsSync(deletedPath));
  assert.ok(!fs.existsSync(renamedOld));
  assert.match(fs.readFileSync(path.join(projectDir, "new-name.ts"), "utf8"), /value = 2/);
  assert.match(fs.readFileSync(updatedPath, "utf8"), /const next = 2/);
  assert.ok(result.files.some((file) => file.status === "created"));
  assert.ok(result.files.some((file) => file.status === "deleted"));
  assert.ok(result.files.some((file) => file.status === "renamed"));
  assert.ok(result.files.some((file) => file.status === "updated"));
});

test("applyUnifiedPatch preserves CRLF updates and blocks paths outside the workspace", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-patch-crlf-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "windows.txt");
  fs.writeFileSync(filePath, "alpha\r\nbeta\r\n", "utf8");

  const patch = [
    "--- a/windows.txt",
    "+++ b/windows.txt",
    "@@ -1,2 +1,2 @@",
    " alpha",
    "-beta",
    "+gamma",
    "",
  ].join("\n");
  applyUnifiedPatch(projectDir, { patch, apply: true });
  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /\r\n/);
  assert.ok(updated.endsWith("\r\n"));

  const escapingPatch = [
    "--- a/../outside.txt",
    "+++ b/../outside.txt",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  assert.throws(() => applyUnifiedPatch(projectDir, { patch: escapingPatch, apply: false }), /escapes the workspace root/i);
});
