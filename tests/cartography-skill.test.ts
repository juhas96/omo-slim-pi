import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("package bundles the karpathy-guidelines and cartography skills and exposes them via the pi manifest", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    files?: string[];
    pi?: { skills?: string[] };
  };
  const cartographyPath = path.join(process.cwd(), "skills", "cartography", "SKILL.md");
  const karpathyPath = path.join(process.cwd(), "skills", "karpathy-guidelines", "SKILL.md");
  const cartographyText = fs.readFileSync(cartographyPath, "utf8");
  const karpathyText = fs.readFileSync(karpathyPath, "utf8");

  assert.ok(packageJson.files?.includes("skills"));
  assert.ok(packageJson.pi?.skills?.includes("./skills"));

  assert.match(cartographyText, /^---\nname: cartography\n/m);
  assert.match(cartographyText, /hierarchical `codemap\.md` files/);
  assert.match(cartographyText, /\.pi\/cartography\.json/);
  assert.match(cartographyText, /scripts\/cartographer\.mjs/);
  assert.match(cartographyText, /pantheon_repo_map/);
  assert.match(cartographyText, /pantheon_code_map/);
  assert.match(cartographyText, /## Repository Map/);

  assert.match(karpathyText, /^---\nname: karpathy-guidelines\n/m);
  assert.match(karpathyText, /Behavioral guardrails/);
  assert.match(karpathyText, /Think Before Coding/);
  assert.match(karpathyText, /Simplicity First/);
  assert.match(karpathyText, /Surgical Changes/);
  assert.match(karpathyText, /Goal-Driven Execution/);
});
