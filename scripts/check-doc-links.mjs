#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(["node_modules", ".git", ".oh-my-opencode-pi-debug"]);
const MARKDOWN_FILES = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".md")) MARKDOWN_FILES.push(fullPath);
  }
}

function isExternal(target) {
  return target.startsWith("#") || target.startsWith("mailto:") || /^[a-z]+:\/\//i.test(target);
}

function normalizeTarget(baseFile, target) {
  const [fileTarget] = target.split("#", 1);
  return path.normalize(path.join(path.dirname(baseFile), fileTarget));
}

walk(ROOT);

const markdownLinkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const missing = [];

for (const file of MARKDOWN_FILES) {
  const text = fs.readFileSync(file, "utf8");
  let match;
  while ((match = markdownLinkPattern.exec(text)) !== null) {
    const target = match[1];
    if (isExternal(target)) continue;
    const resolved = normalizeTarget(file, target);
    if (!fs.existsSync(resolved)) {
      missing.push({ file: path.relative(ROOT, file), target, resolved: path.relative(ROOT, resolved) });
    }
  }
}

if (missing.length > 0) {
  console.error("Broken local markdown links detected:\n");
  for (const item of missing) {
    console.error(`- ${item.file}: ${item.target} -> missing (${item.resolved})`);
  }
  process.exit(1);
}

console.log(`Markdown link check passed (${MARKDOWN_FILES.length} files).`);
