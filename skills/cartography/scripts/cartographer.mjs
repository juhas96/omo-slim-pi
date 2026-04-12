#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

export const VERSION = "1.0.0";
export const STATE_DIR = ".pi";
export const STATE_FILE = "cartography.json";
export const CODEMAP_FILE = "codemap.md";
export const AGENTS_FILE = "AGENTS.md";
export const REPOSITORY_MAP_SECTION = `## Repository Map

A full codemap is available at \`codemap.md\` in the project root.

Before working on any task, read \`codemap.md\` to understand:
- project architecture and entry points
- directory responsibilities and design patterns
- data flow and integration points between modules

For deep work on a specific folder, also read that folder's \`codemap.md\`.
`;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function loadGitignore(root) {
  const gitignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return [];
  return fs.readFileSync(gitignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

class PatternMatcher {
  constructor(patterns) {
    if (!patterns || patterns.length === 0) {
      this.regex = null;
      return;
    }
    const regexParts = [];
    for (const pattern of patterns) {
      let reg = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
      reg = reg.replace(/\*\*\//g, "__GLOBSTAR_SLASH__");
      reg = reg.replace(/\*\*/g, "__GLOBSTAR__");
      reg = reg.replace(/\*/g, "[^/]*");
      reg = reg.replace(/\?/g, ".");
      reg = reg.replace(/__GLOBSTAR_SLASH__/g, "(?:.*/)?");
      reg = reg.replace(/__GLOBSTAR__/g, ".*");
      if (pattern.endsWith("/")) reg += ".*";
      if (pattern.startsWith("/")) reg = `^${reg.slice(1)}`;
      else reg = `(?:^|.*/)${reg}`;
      regexParts.push(`(?:${reg}$)`);
    }
    this.regex = new RegExp(regexParts.join("|"));
  }

  matches(filePath) {
    if (!this.regex) return false;
    return this.regex.test(filePath);
  }
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      files.push(fullPath);
    }
  };
  visit(root);
  return files.sort();
}

export function selectFiles(root, includePatterns = ["**/*"], excludePatterns = [], exceptions = [], gitignorePatterns = []) {
  const includeMatcher = new PatternMatcher(includePatterns);
  const excludeMatcher = new PatternMatcher(excludePatterns);
  const gitignoreMatcher = new PatternMatcher(gitignorePatterns);
  const exceptionSet = new Set(exceptions.map((item) => toPosix(item)));

  return walkFiles(root).filter((filePath) => {
    const relative = toPosix(path.relative(root, filePath));
    if (!relative || relative.startsWith("..")) return false;
    if (gitignoreMatcher.matches(relative)) return false;
    if (excludeMatcher.matches(relative) && !exceptionSet.has(relative)) return false;
    return includeMatcher.matches(relative) || exceptionSet.has(relative);
  });
}

export function computeFileHash(filePath) {
  try {
    const hash = crypto.createHash("md5");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
  } catch {
    return "";
  }
}

export function getFoldersWithFiles(files, root) {
  const folders = new Set(["."]);
  for (const filePath of files) {
    const parts = toPosix(path.relative(root, filePath)).split("/").slice(0, -1);
    for (let i = 0; i < parts.length; i += 1) {
      folders.add(parts.slice(0, i + 1).join("/"));
    }
  }
  return folders;
}

export function computeFolderHash(folder, fileHashes) {
  const pairs = Object.entries(fileHashes)
    .filter(([filePath]) => folder === "." ? !filePath.includes("/") : filePath.startsWith(`${folder}/`))
    .sort(([a], [b]) => a.localeCompare(b));
  if (pairs.length === 0) return "";
  const hash = crypto.createHash("md5");
  for (const [filePath, digest] of pairs) hash.update(`${filePath}:${digest}\n`);
  return hash.digest("hex");
}

function statePath(root) {
  return path.join(root, STATE_DIR, STATE_FILE);
}

export function loadState(root) {
  const filePath = statePath(root);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function saveState(root, state) {
  const dir = path.join(root, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

export function createEmptyCodemap(folderPath, folderName) {
  const filePath = path.join(folderPath, CODEMAP_FILE);
  if (fs.existsSync(filePath)) return;
  const content = `# ${folderName}/\n\n<!-- Explorer: Fill in this section with architectural understanding -->\n\n## Responsibility\n\n<!-- What is this folder's job in the system? -->\n\n## Design\n\n<!-- Key patterns, abstractions, architectural decisions -->\n\n## Flow\n\n<!-- How does data/control flow through this module? -->\n\n## Integration\n\n<!-- How does it connect to other parts of the system? -->\n`;
  fs.writeFileSync(filePath, content);
}

function pickRootAssets(files) {
  const preferred = [
    "package.json",
    "README.md",
    "src/index.ts",
    "src/main.ts",
    "extensions/oh-my-opencode-pi/index.ts",
    "bin/oh-my-opencode-pi.mjs",
    "app/page.tsx",
    "app/layout.tsx",
  ];
  const matches = preferred.filter((item) => files.includes(item));
  return matches.length > 0 ? matches : files.filter((item) => !item.includes("/")).slice(0, 6);
}

export function buildRootAtlasTemplate(root, files, folders) {
  const projectName = path.basename(root);
  const rootAssets = pickRootAssets(files);
  const mappedFolders = folders.filter((folder) => folder !== ".");
  const directoryRows = mappedFolders.length > 0
    ? mappedFolders.map((folder) => `| \`${folder}/\` | TODO: summarize this directory's responsibility. | [View Map](${folder}/codemap.md) |`).join("\n")
    : "| `(no subdirectories tracked yet)` | TODO: add scoped directories once cartography expands. | - |";
  const entryPoints = rootAssets.length > 0
    ? rootAssets.map((file) => `- \`${file}\`: TODO: describe why this entry point matters.`).join("\n")
    : "- `codemap.md`: Root architecture atlas for this repository.";
  return `# Repository Atlas: ${projectName}\n\n## Project Responsibility\n\nTODO: Describe the overall purpose of this repository and the architectural problem it solves.\n\n## System Entry Points\n\n${entryPoints}\n\n## Directory Map\n\n| Directory | Responsibility Summary | Detailed Map |\n|-----------|------------------------|--------------|\n${directoryRows}\n\n## Notes for Future Mapping\n\n- Replace TODO summaries as explorer passes fill in subdirectory codemaps.\n- Keep this atlas as the master entry point for repository understanding.\n`;
}

export function ensureRootAtlasTemplate(root, files, folders) {
  const filePath = path.join(root, CODEMAP_FILE);
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, buildRootAtlasTemplate(root, files, folders));
  return true;
}

export function ensureAgentsRepositoryMapSection(root) {
  const filePath = path.join(root, AGENTS_FILE);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${REPOSITORY_MAP_SECTION}\n`);
    return true;
  }
  const existing = fs.readFileSync(filePath, "utf8");
  if (/^## Repository Map\b/m.test(existing)) return false;
  const trimmed = existing.replace(/\s+$/, "");
  fs.writeFileSync(filePath, `${trimmed}\n\n${REPOSITORY_MAP_SECTION}\n`);
  return true;
}

function snapshot(root, includePatterns, excludePatterns, exceptions) {
  const files = selectFiles(root, includePatterns, excludePatterns, exceptions, loadGitignore(root));
  const fileHashes = Object.fromEntries(files.map((filePath) => [toPosix(path.relative(root, filePath)), computeFileHash(filePath)]));
  const folders = [...getFoldersWithFiles(files, root)].sort();
  const folderHashes = Object.fromEntries(folders.map((folder) => [folder, computeFolderHash(folder, fileHashes)]));
  return { files, fileHashes, folders, folderHashes };
}

export function initCartography(root, options = {}) {
  const includePatterns = options.include?.length ? options.include : ["**/*"];
  const excludePatterns = options.exclude?.length ? options.exclude : [];
  const exceptions = options.exception?.length ? options.exception : [];
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Root is not a directory: ${resolvedRoot}`);
  }

  const { files, fileHashes, folders, folderHashes } = snapshot(resolvedRoot, includePatterns, excludePatterns, exceptions);
  const state = {
    metadata: {
      version: VERSION,
      lastRun: new Date().toISOString(),
      root: resolvedRoot,
      includePatterns,
      excludePatterns,
      exceptions,
      stateDir: STATE_DIR,
      stateFile: STATE_FILE,
    },
    fileHashes,
    folderHashes,
  };
  saveState(resolvedRoot, state);
  const rootAtlasCreated = ensureRootAtlasTemplate(resolvedRoot, files.map((filePath) => toPosix(path.relative(resolvedRoot, filePath))), folders);
  for (const folder of folders) {
    if (folder === ".") continue;
    const folderPath = path.join(resolvedRoot, folder);
    createEmptyCodemap(folderPath, folder);
  }
  const agentsUpdated = ensureAgentsRepositoryMapSection(resolvedRoot);
  return {
    root: resolvedRoot,
    filesSelected: files.length,
    foldersCreated: folders.length,
    includePatterns,
    excludePatterns,
    exceptions,
    statePath: statePath(resolvedRoot),
    rootAtlasCreated,
    agentsUpdated,
  };
}

export function detectCartographyChanges(root) {
  const resolvedRoot = path.resolve(root);
  const state = loadState(resolvedRoot);
  if (!state) throw new Error(`No cartography state found. Run 'init' first. Expected ${STATE_DIR}/${STATE_FILE}.`);
  const includePatterns = state.metadata?.includePatterns ?? ["**/*"];
  const excludePatterns = state.metadata?.excludePatterns ?? [];
  const exceptions = state.metadata?.exceptions ?? [];
  const { fileHashes: currentHashes } = snapshot(resolvedRoot, includePatterns, excludePatterns, exceptions);
  const savedHashes = state.fileHashes ?? {};

  const currentPaths = new Set(Object.keys(currentHashes));
  const savedPaths = new Set(Object.keys(savedHashes));
  const added = [...currentPaths].filter((item) => !savedPaths.has(item)).sort();
  const removed = [...savedPaths].filter((item) => !currentPaths.has(item)).sort();
  const modified = [...currentPaths].filter((item) => savedPaths.has(item) && currentHashes[item] !== savedHashes[item]).sort();

  const affectedFolders = new Set(["."]);
  for (const filePath of [...added, ...removed, ...modified]) {
    const parts = filePath.split("/").slice(0, -1);
    for (let i = 0; i < parts.length; i += 1) affectedFolders.add(parts.slice(0, i + 1).join("/"));
  }

  return { root: resolvedRoot, added, removed, modified, affectedFolders: [...affectedFolders].sort(), hasChanges: added.length > 0 || removed.length > 0 || modified.length > 0 };
}

export function updateCartographyState(root) {
  const resolvedRoot = path.resolve(root);
  const state = loadState(resolvedRoot);
  if (!state) throw new Error(`No cartography state found. Run 'init' first. Expected ${STATE_DIR}/${STATE_FILE}.`);
  const includePatterns = state.metadata?.includePatterns ?? ["**/*"];
  const excludePatterns = state.metadata?.excludePatterns ?? [];
  const exceptions = state.metadata?.exceptions ?? [];
  const { files, fileHashes, folders, folderHashes } = snapshot(resolvedRoot, includePatterns, excludePatterns, exceptions);
  const nextState = {
    ...state,
    metadata: {
      ...state.metadata,
      lastRun: new Date().toISOString(),
    },
    fileHashes,
    folderHashes,
  };
  saveState(resolvedRoot, nextState);
  const relativeFiles = files.map((filePath) => toPosix(path.relative(resolvedRoot, filePath)));
  const rootAtlasCreated = ensureRootAtlasTemplate(resolvedRoot, relativeFiles, folders);
  for (const folder of folders) {
    if (folder === ".") continue;
    const folderPath = path.join(resolvedRoot, folder);
    createEmptyCodemap(folderPath, folder);
  }
  const agentsUpdated = ensureAgentsRepositoryMapSection(resolvedRoot);
  return { root: resolvedRoot, filesSelected: files.length, foldersTracked: folders.length, statePath: statePath(resolvedRoot), rootAtlasCreated, agentsUpdated };
}

function formatChanges(result) {
  if (!result.hasChanges) return "No changes detected.";
  const lines = [];
  if (result.added.length > 0) {
    lines.push(`\n${result.added.length} added:`);
    for (const item of result.added) lines.push(`  + ${item}`);
  }
  if (result.removed.length > 0) {
    lines.push(`\n${result.removed.length} removed:`);
    for (const item of result.removed) lines.push(`  - ${item}`);
  }
  if (result.modified.length > 0) {
    lines.push(`\n${result.modified.length} modified:`);
    for (const item of result.modified) lines.push(`  ~ ${item}`);
  }
  lines.push(`\n${result.affectedFolders.length} folders affected:`);
  for (const folder of result.affectedFolders) lines.push(`  ${folder}/`);
  return lines.join("\n").trim();
}

function formatInitSummary(result) {
  const relativeStatePath = path.relative(result.root, result.statePath) || `${STATE_DIR}/${STATE_FILE}`;
  return [
    `Cartography initialized for ${result.root}`,
    `- State file: ${relativeStatePath}`,
    `- Files selected: ${result.filesSelected}`,
    `- Folders tracked: ${result.foldersCreated}`,
    `- Root atlas: ${result.rootAtlasCreated ? `created (${CODEMAP_FILE})` : `kept existing (${CODEMAP_FILE})`}`,
    `- AGENTS.md repository map: ${result.agentsUpdated ? "ensured" : "already present"}`,
    "",
    "Next steps:",
    "- Fill in the root codemap atlas and any new folder codemap.md files.",
    "- Delegate explorer passes for detailed folder-level mapping when needed.",
    `- Re-run \`node skills/cartography/scripts/cartographer.mjs changes --root .\` before future refreshes.`,
  ].join("\n");
}

function formatUpdateSummary(result) {
  const relativeStatePath = path.relative(result.root, result.statePath) || `${STATE_DIR}/${STATE_FILE}`;
  return [
    `Cartography state updated for ${result.root}`,
    `- State file: ${relativeStatePath}`,
    `- Files selected: ${result.filesSelected}`,
    `- Folders tracked: ${result.foldersTracked}`,
    `- Root atlas: ${result.rootAtlasCreated ? `created (${CODEMAP_FILE})` : `kept existing (${CODEMAP_FILE})`}`,
    `- AGENTS.md repository map: ${result.agentsUpdated ? "ensured" : "already present"}`,
    "",
    "Next steps:",
    "- Refresh affected codemap.md files if code structure changed.",
    "- Keep the root atlas aligned with directory-level codemap summaries.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, root: undefined, include: [], exclude: [], exception: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const value = rest[index + 1];
    if (token === "--root") {
      args.root = value;
      index += 1;
      continue;
    }
    if (token === "--include") {
      args.include.push(value);
      index += 1;
      continue;
    }
    if (token === "--exclude") {
      args.exclude.push(value);
      index += 1;
      continue;
    }
    if (token === "--exception") {
      args.exception.push(value);
      index += 1;
      continue;
    }
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.command || !args.root) {
    console.error("Usage: cartographer.mjs <init|changes|update> --root <path> [--include <glob>] [--exclude <glob>] [--exception <path>]");
    return 1;
  }
  try {
    if (args.command === "init") {
      const result = initCartography(args.root, args);
      console.log(formatInitSummary(result));
      return 0;
    }
    if (args.command === "changes") {
      console.log(formatChanges(detectCartographyChanges(args.root)));
      return 0;
    }
    if (args.command === "update") {
      const result = updateCartographyState(args.root);
      console.log(formatUpdateSummary(result));
      return 0;
    }
    console.error(`Unknown command: ${args.command}`);
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/cartographer.mjs")) {
  process.exit(main());
}
