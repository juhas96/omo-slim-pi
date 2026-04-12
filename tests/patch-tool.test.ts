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

  const applied = applyUnifiedPatch(projectDir, { patch, apply: true });
  assert.equal(applied.applied, true);
  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /const value = 2;/);
});
