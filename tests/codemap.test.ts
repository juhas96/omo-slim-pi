import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCodeMap } from "../extensions/oh-my-opencode-pi/tools/codemap.ts";

test("buildCodeMap reports architecture summaries, workspace boundaries, and import cycles", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-codemap-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "packages", "ui", "src"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "tests"), { recursive: true });

  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
    name: "demo",
    main: "src/index.ts",
    workspaces: ["packages/*"],
  }, null, 2));
  fs.writeFileSync(path.join(projectDir, "packages", "ui", "package.json"), JSON.stringify({ name: "@demo/ui" }, null, 2));
  fs.writeFileSync(path.join(projectDir, "src", "util.ts"), "import { boot } from './index';\nexport function helper() { return boot(); }\n");
  fs.writeFileSync(path.join(projectDir, "src", "index.ts"), [
    "import { helper } from './util';",
    "export class DemoService {",
    "  value() { return helper(); }",
    "}",
    "export function boot() { return 1; }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(projectDir, "packages", "ui", "src", "button.ts"), "export function Button() { return 'ok'; }\n");
  fs.writeFileSync(path.join(projectDir, "tests", "demo.test.ts"), "import { DemoService } from '../src/index';\nexport const demo = new DemoService();\n");

  const result = buildCodeMap(projectDir, { maxFiles: 20, maxSymbols: 20, maxEdges: 20 });
  assert.ok(result.entrypoints.includes("src/index.ts"));
  assert.ok(result.edges.some((edge) => edge.from === "src/index.ts" && edge.to === "src/util.ts"));
  assert.ok(result.files.some((file) => file.path === "src/index.ts" && file.symbols.some((symbol) => symbol.name === "DemoService")));
  assert.ok(result.packageBoundaries.some((entry) => entry.includes("workspace:packages/*")));
  assert.ok(result.packageBoundaries.some((entry) => entry.includes("packages/ui") && entry.includes("@demo/ui")));
  assert.ok(result.directoryRoles.some((entry) => entry.path === "src" && entry.role === "source"));
  assert.ok(result.directoryRoles.some((entry) => entry.path === "tests" && entry.role === "tests"));
  assert.ok(result.cycles.some((cycle) => cycle.join(" -> ").includes("src/index.ts") && cycle.join(" -> ").includes("src/util.ts")));
  assert.ok(result.architecture.length >= 2);
  assert.match(result.text, /Architecture summary:/);
  assert.match(result.text, /Directory roles:/);
  assert.match(result.text, /Import cycles:/);
});
