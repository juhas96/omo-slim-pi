#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "oh-my-opencode-pi.schema.json"), "utf8"));
const expectedUserAgent = `${pkg.name}/${pkg.version}`;
const schemaUserAgent = schema?.properties?.research?.properties?.userAgent?.default;

if (schemaUserAgent !== expectedUserAgent) {
  console.error(`Schema userAgent default mismatch: expected ${expectedUserAgent}, got ${String(schemaUserAgent)}`);
  process.exit(1);
}

const ignoreDirs = new Set(["node_modules", ".git", ".oh-my-opencode-pi-debug"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".md"]);
const versionPattern = /oh-my-opencode-pi\/(\d+\.\d+\.\d+)/g;
const mismatches = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name))) continue;
    const rel = path.relative(root, fullPath);
    if (rel === "package-lock.json") continue;
    const text = fs.readFileSync(fullPath, "utf8");
    let match;
    while ((match = versionPattern.exec(text)) !== null) {
      if (match[1] !== pkg.version) {
        mismatches.push(`${rel}: found oh-my-opencode-pi/${match[1]} (expected ${expectedUserAgent})`);
      }
    }
  }
}

walk(root);

if (mismatches.length > 0) {
  console.error("Version drift detected:\n");
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

console.log(`Version consistency check passed (${expectedUserAgent}).`);
