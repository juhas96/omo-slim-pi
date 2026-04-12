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
      if (pkg.bin && typeof pkg.bin === "object") {
        for (const value of Object.values(pkg.bin as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim()) results.add(value.trim());
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }
  for (const candidate of ["src/index.ts", "src/main.ts", "index.ts", "main.ts", "app/page.tsx", "app/layout.tsx"]) {
    if (fs.existsSync(path.join(root, candidate))) results.add(candidate);
  }
  return [...results];
}

function detectPackageBoundaries(root: string): string[] {
  const boundaries = new Set<string>();
  for (const candidate of ["packages", "apps", "services"]) {
    const dir = path.join(root, candidate);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) boundaries.add(path.join(candidate, entry.name));
      }
    } catch {
      // ignore
    }
  }
  return [...boundaries].sort();
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

  const text = [
    `Root: ${root}`,
    `Source files scanned: ${files.length}`,
    entrypoints.length > 0 ? `Entrypoints:\n${entrypoints.map((entry) => `- ${entry}`).join("\n")}` : "Entrypoints: (none detected)",
    packageBoundaries.length > 0 ? `Package boundaries:\n${packageBoundaries.map((entry) => `- ${entry}`).join("\n")}` : "Package boundaries: (none detected)",
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
    text,
  };
}
