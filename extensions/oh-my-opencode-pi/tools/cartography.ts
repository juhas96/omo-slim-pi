import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";

export const RepoMapParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional project-relative or absolute directory to analyze." })),
  maxFiles: Type.Optional(Type.Number({ description: "Maximum files to scan.", default: 250 })),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth to render.", default: 4 })),
  maxPerDirectory: Type.Optional(Type.Number({ description: "Maximum entries to render per directory level.", default: 8 })),
  includeHidden: Type.Optional(Type.Boolean({ description: "Include dotfiles and dot-directories in the tree view.", default: false })),
});

export interface RepoMapResult {
  root: string;
  filesScanned: number;
  truncated: boolean;
  topDirectories: Array<{ name: string; count: number }>;
  keyFiles: string[];
  extensions: Array<{ ext: string; count: number }>;
  tree: string[];
  text: string;
}

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "out",
]);

function resolveRoot(cwd: string, requestedPath?: string): string {
  const resolved = requestedPath ? (path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath)) : cwd;
  if (!fs.existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  return stat.isDirectory() ? resolved : path.dirname(resolved);
}

function shouldSkip(name: string, includeHidden: boolean, extraExcludes: string[]): boolean {
  if (!includeHidden && name.startsWith(".")) return true;
  if (DEFAULT_IGNORED_DIRS.has(name)) return true;
  return extraExcludes.includes(name);
}

function collectFiles(root: string, includeHidden: boolean, maxFiles: number, extraExcludes: string[]): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string) => {
    if (truncated) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (shouldSkip(entry.name, includeHidden, extraExcludes)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      files.push(path.relative(root, fullPath) || entry.name);
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  visit(root);
  return { files: files.sort(), truncated };
}

function buildTree(root: string, includeHidden: boolean, maxDepth: number, maxPerDirectory: number, extraExcludes: string[]): string[] {
  const lines: string[] = [];

  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const visible = entries
      .filter((entry) => !shouldSkip(entry.name, includeHidden, extraExcludes))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const shown = visible.slice(0, maxPerDirectory);
    for (const entry of shown) {
      const suffix = entry.isDirectory() ? "/" : "";
      lines.push(`${prefix}- ${entry.name}${suffix}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1, `${prefix}  `);
    }
    if (visible.length > shown.length) lines.push(`${prefix}- … (${visible.length - shown.length} more)`);
  };

  walk(root, 1, "");
  return lines;
}

function pickKeyFiles(files: string[]): string[] {
  const preferred = [
    "README.md",
    "package.json",
    "tsconfig.json",
    "jsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    ".pi/oh-my-opencode-pi.json",
    ".pi/oh-my-opencode-pi.jsonc",
    "src/index.ts",
    "src/main.ts",
    "app/page.tsx",
  ];
  const matches = preferred.filter((candidate) => files.includes(candidate));
  const additional = files.filter((file) => /(^|\/)(README|CHANGELOG|AGENTS)\.md$/i.test(file) || /(package|tsconfig|pyproject|Cargo|go\.mod)/.test(file));
  return [...new Set([...matches, ...additional])].slice(0, 12);
}

export function buildRepoMap(cwd: string, params: {
  path?: string;
  maxFiles?: number;
  maxDepth?: number;
  maxPerDirectory?: number;
  includeHidden?: boolean;
  exclude?: string[];
}): RepoMapResult {
  const root = resolveRoot(cwd, params.path);
  const maxFiles = Math.max(1, Math.floor(params.maxFiles ?? 250));
  const maxDepth = Math.max(1, Math.floor(params.maxDepth ?? 4));
  const maxPerDirectory = Math.max(1, Math.floor(params.maxPerDirectory ?? 8));
  const includeHidden = params.includeHidden === true;
  const extraExcludes = [...new Set((params.exclude ?? []).map((item) => item.trim()).filter(Boolean))];

  const { files, truncated } = collectFiles(root, includeHidden, maxFiles, extraExcludes);
  const topDirCounts = new Map<string, number>();
  const extensionCounts = new Map<string, number>();
  for (const file of files) {
    const firstSegment = file.split(path.sep)[0] || ".";
    topDirCounts.set(firstSegment, (topDirCounts.get(firstSegment) ?? 0) + 1);
    const ext = path.extname(file) || "(no extension)";
    extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
  }

  const topDirectories = [...topDirCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 12);
  const extensions = [...extensionCounts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext))
    .slice(0, 10);
  const keyFiles = pickKeyFiles(files);
  const tree = buildTree(root, includeHidden, maxDepth, maxPerDirectory, extraExcludes);

  const sections = [
    `Root: ${root}`,
    `Files scanned: ${files.length}${truncated ? ` (truncated at ${maxFiles})` : ""}`,
    topDirectories.length > 0
      ? `Top directories:\n${topDirectories.map((entry) => `- ${entry.name}: ${entry.count}`).join("\n")}`
      : "Top directories: (none)",
    keyFiles.length > 0
      ? `Key files:\n${keyFiles.map((file) => `- ${file}`).join("\n")}`
      : "Key files: (none)",
    extensions.length > 0
      ? `Extension mix:\n${extensions.map((entry) => `- ${entry.ext}: ${entry.count}`).join("\n")}`
      : "Extension mix: (none)",
    tree.length > 0
      ? `Tree preview:\n${tree.join("\n")}`
      : "Tree preview: (empty)",
  ];

  return {
    root,
    filesScanned: files.length,
    truncated,
    topDirectories,
    keyFiles,
    extensions,
    tree,
    text: sections.join("\n\n"),
  };
}
