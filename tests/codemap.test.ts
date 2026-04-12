import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCodeMap } from "../extensions/oh-my-opencode-pi/tools/codemap.ts";

test("buildCodeMap reports entrypoints, import edges, and symbols", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-codemap-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "demo", main: "src/index.ts" }, null, 2));
  fs.writeFileSync(path.join(projectDir, "src", "util.ts"), "export function helper() { return 1; }\n");
  fs.writeFileSync(path.join(projectDir, "src", "index.ts"), [
    "import { helper } from './util';",
    "export class DemoService {",
    "  value() { return helper(); }",
    "}",
    "",
  ].join("\n"));

  const result = buildCodeMap(projectDir, { maxFiles: 20, maxSymbols: 20, maxEdges: 20 });
  assert.ok(result.entrypoints.includes("src/index.ts"));
  assert.ok(result.edges.some((edge) => edge.from === "src/index.ts" && edge.to === "src/util.ts"));
  assert.ok(result.files.some((file) => file.path === "src/index.ts" && file.symbols.some((symbol) => symbol.name === "DemoService")));
  assert.match(result.text, /Hotspots:/);
});
