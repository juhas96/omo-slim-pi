import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { Type } from "@sinclair/typebox";

export const CodeMapParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional project-relative or absolute directory to analyze." })),
  maxFiles: Type.Optional(Type.Number({ description: "Maximum source files to scan.", default: 80 })),
  maxSymbols: Type.Optional(Type.Number({ description: "Maximum symbols to report.", default: 60 })),
  maxEdges: Type.Optional(Type.Number({ description: "Maximum import edges to report.", default: 25 })),
});

export interface CodeMapFile {
  path: string;
  imports: string[];
  exports: string[];
  symbols: Array<{ name: string; kind: string }>;
}

export interface CodeMapResult {
  root: string;
  files: CodeMapFile[];
  entrypoints: string[];
  packageBoundaries: string[];
  edges: Array<{ from: string; to: string }>;
  hotspots: Array<{ path: string; inbound: number; outbound: number; symbols: number }>;
  directoryRoles: Array<{ path: string; role: string; files: number }>;
  cycles: string[][];
  architecture: string[];
  text: string;
}

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".cache", "out", "target"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);

function resolveRoot(cwd: string, requestedPath?: string): string {
  const resolved = requestedPath ? (path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath)) : cwd;
  if (!fs.existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
  return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
}

function walkSourceFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      files.push(path.join(dir, entry.name));
    }
  };
  visit(root);
  return files.sort();
}

function extractSymbolName(node: ts.Node): string | undefined {
  if ("name" in node && node.name && ts.isIdentifier(node.name as ts.Node)) return (node.name as ts.Identifier).text;
  return undefined;
}

function resolveImportTarget(filePath: string, moduleSpecifier: string, knownFiles: Set<string>): string | undefined {
  if (!moduleSpecifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(filePath), moduleSpecifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.jsx"),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function parseSourceFile(filePath: string, root: string, knownFiles: Set<string>): CodeMapFile {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const exports: string[] = [];
  const symbols: Array<{ name: string; kind: string }> = [];

  const addSymbol = (name: string | undefined, kind: string) => {
    if (!name) return;
    symbols.push({ name, kind });
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveImportTarget(filePath, stmt.moduleSpecifier.text, knownFiles);
      if (target) imports.push(path.relative(root, target));
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) exports.push(element.name.text);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      addSymbol(extractSymbolName(stmt), "function");
      if (stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && stmt.name) exports.push(stmt.name.text);
      continue;
    }
    if (ts.isClassDeclaration(stmt)) {
      addSymbol(extractSymbolName(stmt), "class");
      if (stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) && stmt.name) exports.push(stmt.name.text);
      continue;
    }
    if (ts.isInterfaceDeclaration(stmt)) {
      addSymbol(stmt.name.text, "interface");
      if (stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exports.push(stmt.name.text);
      continue;
    }
    if (ts.isTypeAliasDeclaration(stmt)) {
      addSymbol(stmt.name.text, "type");
      if (stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exports.push(stmt.name.text);
      continue;
    }
    if (ts.isEnumDeclaration(stmt)) {
      addSymbol(stmt.name.text, "enum");
      if (stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exports.push(stmt.name.text);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      const isExported = stmt.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      for (const declaration of stmt.declarationList.declarations) {
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
        addSymbol(name, "variable");
        if (isExported && name) exports.push(name);
      }
    }
  }

  return {
    path: path.relative(root, filePath),
    imports: [...new Set(imports)].sort(),
    exports: [...new Set(exports)].sort(),
    symbols,
  };
}

function detectEntrypoints(root: string): string[] {
  const results = new Set<string>();
  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
      for (const key of ["main", "module", "types"]) {
        const value = pkg[key];
        if (typeof value === "string" && value.trim()) results.add(value.trim());
      }
      if (pkg.exports && typeof pkg.exports === "object") {
        for (const value of Object.values(pkg.exports as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim()) results.add(value.trim());
          if (value && typeof value === "object") {
            for (const nested of Object.values(value as Record<string, unknown>)) {
              if (typeof nested === "string" && nested.trim()) results.add(nested.trim());
            }
          }
        }
      }
      if (pkg.bin && typeof pkg.bin === "object") {
        for (const value of Object.values(pkg.bin as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim()) results.add(value.trim());
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }
  for (const candidate of ["src/index.ts", "src/main.ts", "index.ts", "main.ts", "app/page.tsx", "app/layout.tsx", "cli.ts"]) {
    if (fs.existsSync(path.join(root, candidate))) results.add(candidate);
  }
  return [...results].sort();
}

function readPackageName(packageJsonPath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function detectPackageBoundaries(root: string): string[] {
  const boundaries = new Set<string>();
  const rootPackageJson = path.join(root, "package.json");
  if (fs.existsSync(rootPackageJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPackageJson, "utf8")) as Record<string, unknown>;
      const workspaces = Array.isArray(pkg.workspaces)
        ? pkg.workspaces.filter((entry): entry is string => typeof entry === "string")
        : Array.isArray((pkg.workspaces as { packages?: unknown[] } | undefined)?.packages)
          ? ((pkg.workspaces as { packages?: unknown[] }).packages ?? []).filter((entry): entry is string => typeof entry === "string")
          : [];
      for (const workspace of workspaces) boundaries.add(`workspace:${workspace}`);
    } catch {
      // ignore malformed package.json
    }
  }

  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const packageJsonPath = path.join(full, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        const rel = path.relative(root, full);
        const name = readPackageName(packageJsonPath);
        boundaries.add(name ? `${rel} (${name})` : rel);
      }
      visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return [...boundaries].sort();
}

function classifyDirectoryRole(dir: string): string {
  const normalized = dir.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(normalized)) return "tests";
  if (/(^|\/)(doc|docs)(\/|$)/.test(normalized)) return "docs";
  if (/(^|\/)(app|pages|components|ui)(\/|$)/.test(normalized)) return "ui";
  if (/(^|\/)(scripts|tools|bin|cli)(\/|$)/.test(normalized)) return "tooling";
  if (/(^|\/)(types|models|schemas)(\/|$)/.test(normalized)) return "types";
  if (/(^|\/)(services|server|api)(\/|$)/.test(normalized)) return "services";
  if (normalized === ".") return "root";
  return "source";
}

function detectDirectoryRoles(files: CodeMapFile[]): Array<{ path: string; role: string; files: number }> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = path.dirname(file.path);
    const top = dir === "." ? "." : dir.split(path.sep)[0];
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dirPath, fileCount]) => ({ path: dirPath, role: classifyDirectoryRole(dirPath), files: fileCount }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

function findImportCycles(files: CodeMapFile[], limit = 5): string[][] {
  const graph = new Map<string, string[]>();
  for (const file of files) graph.set(file.path, file.imports.filter((item) => item !== file.path));
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (start: string, current: string, stack: string[], active: Set<string>) => {
    if (cycles.length >= limit) return;
    const nextItems = graph.get(current) ?? [];
    for (const next of nextItems) {
      if (next === start && stack.length > 1) {
        const cycle = [...stack, start];
        const canonical = [...cycle.slice(0, -1)].sort().join("|");
        if (!seen.has(canonical)) {
          seen.add(canonical);
          cycles.push(cycle);
        }
        continue;
      }
      if (active.has(next) || stack.length >= 6) continue;
      active.add(next);
      visit(start, next, [...stack, next], active);
      active.delete(next);
    }
  };

  for (const file of files.map((item) => item.path)) {
    visit(file, file, [file], new Set([file]));
    if (cycles.length >= limit) break;
  }
  return cycles;
}

function buildArchitectureSummary(args: {
  entrypoints: string[];
  packageBoundaries: string[];
  hotspots: Array<{ path: string; inbound: number; outbound: number; symbols: number }>;
  directoryRoles: Array<{ path: string; role: string; files: number }>;
  cycles: string[][];
  files: CodeMapFile[];
}): string[] {
  const lines: string[] = [];
  if (args.entrypoints.length > 0) {
    lines.push(`Entrypoints suggest the primary launch surface is ${args.entrypoints.slice(0, 3).join(", ")}${args.entrypoints.length > 3 ? "…" : ""}.`);
  }
  if (args.hotspots[0]) {
    const hotspot = args.hotspots[0];
    lines.push(`The most central module is ${hotspot.path} (fan-in ${hotspot.inbound}, fan-out ${hotspot.outbound}, symbols ${hotspot.symbols}).`);
  }
  if (args.directoryRoles.length > 0) {
    lines.push(`Top code areas: ${args.directoryRoles.slice(0, 4).map((item) => `${item.path} [${item.role}]`).join(", ")}.`);
  }
  if (args.packageBoundaries.length > 0) {
    lines.push(`Detected ${args.packageBoundaries.length} package/workspace boundary${args.packageBoundaries.length === 1 ? "" : "ies"}.`);
  }
  if (args.cycles.length > 0) {
    lines.push(`Import cycles detected: ${args.cycles.slice(0, 2).map((cycle) => cycle.join(" -> ")).join("; ")}.`);
  }
  const exportedFiles = args.files.filter((file) => file.exports.length > 0).length;
  if (exportedFiles > 0) {
    lines.push(`${exportedFiles} file${exportedFiles === 1 ? " exposes" : "s expose"} exports that likely form public or shared boundaries.`);
  }
  return lines;
}

export function buildCodeMap(cwd: string, params: { path?: string; maxFiles?: number; maxSymbols?: number; maxEdges?: number }): CodeMapResult {
  const root = resolveRoot(cwd, params.path);
  const maxFiles = Math.max(1, Math.floor(params.maxFiles ?? 80));
  const maxSymbols = Math.max(1, Math.floor(params.maxSymbols ?? 60));
  const maxEdges = Math.max(1, Math.floor(params.maxEdges ?? 25));
  const absoluteFiles = walkSourceFiles(root, maxFiles);
  const knownFiles = new Set(absoluteFiles);
  const files = absoluteFiles.map((filePath) => parseSourceFile(filePath, root, knownFiles));
  const entrypoints = detectEntrypoints(root);
  const packageBoundaries = detectPackageBoundaries(root);
  const edges = files.flatMap((file) => file.imports.map((target) => ({ from: file.path, to: target })));

  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const edge of edges) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const hotspots = files
    .map((file) => ({
      path: file.path,
      inbound: inbound.get(file.path) ?? 0,
      outbound: outbound.get(file.path) ?? 0,
      symbols: file.symbols.length,
    }))
    .sort((a, b) => (b.inbound + b.outbound + b.symbols) - (a.inbound + a.outbound + a.symbols) || a.path.localeCompare(b.path))
    .slice(0, 12);

  const keySymbols = files
    .flatMap((file) => file.symbols.slice(0, 8).map((symbol) => ({ ...symbol, path: file.path })))
    .slice(0, maxSymbols);

  const directoryRoles = detectDirectoryRoles(files);
  const cycles = findImportCycles(files);
  const architecture = buildArchitectureSummary({ entrypoints, packageBoundaries, hotspots, directoryRoles, cycles, files });

  const text = [
    `Root: ${root}`,
    `Source files scanned: ${files.length}`,
    entrypoints.length > 0 ? `Entrypoints:\n${entrypoints.map((entry) => `- ${entry}`).join("\n")}` : "Entrypoints: (none detected)",
    packageBoundaries.length > 0 ? `Package boundaries:\n${packageBoundaries.map((entry) => `- ${entry}`).join("\n")}` : "Package boundaries: (none detected)",
    architecture.length > 0 ? `Architecture summary:\n${architecture.map((line) => `- ${line}`).join("\n")}` : "Architecture summary: (none)",
    directoryRoles.length > 0 ? `Directory roles:\n${directoryRoles.slice(0, 8).map((entry) => `- ${entry.path} [${entry.role}] (${entry.files} files)`).join("\n")}` : "Directory roles: (none)",
    cycles.length > 0 ? `Import cycles:\n${cycles.map((cycle) => `- ${cycle.join(" -> ")}`).join("\n")}` : "Import cycles: (none detected)",
    hotspots.length > 0 ? `Hotspots:\n${hotspots.map((file) => `- ${file.path} (in:${file.inbound} out:${file.outbound} symbols:${file.symbols})`).join("\n")}` : "Hotspots: (none)",
    edges.length > 0 ? `Import edges:\n${edges.slice(0, maxEdges).map((edge) => `- ${edge.from} -> ${edge.to}`).join("\n")}` : "Import edges: (none)",
    keySymbols.length > 0 ? `Key symbols:\n${keySymbols.map((symbol) => `- ${symbol.path}: ${symbol.kind} ${symbol.name}`).join("\n")}` : "Key symbols: (none)",
  ].join("\n\n");

  return {
    root,
    files,
    entrypoints,
    packageBoundaries,
    edges,
    hotspots,
    directoryRoles,
    cycles,
    architecture,
    text,
  };
}
