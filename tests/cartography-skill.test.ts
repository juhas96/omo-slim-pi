import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("package bundles the cartography skill and exposes it via the pi manifest", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    files?: string[];
    pi?: { skills?: string[] };
  };
  const skillPath = path.join(process.cwd(), "skills", "cartography", "SKILL.md");
  const skillText = fs.readFileSync(skillPath, "utf8");

  assert.ok(packageJson.files?.includes("skills"));
  assert.ok(packageJson.pi?.skills?.includes("./skills"));
  assert.match(skillText, /^---\nname: cartography\n/m);
  assert.match(skillText, /hierarchical `codemap\.md` files/);
  assert.match(skillText, /\.pi\/cartography\.json/);
  assert.match(skillText, /scripts\/cartographer\.mjs/);
  assert.match(skillText, /pantheon_repo_map/);
  assert.match(skillText, /pantheon_code_map/);
  assert.match(skillText, /## Repository Map/);
});
