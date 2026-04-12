import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LspDiagnostic, LspLocation, LspRenameFileEdit, LspSymbol } from "./lsp.js";

interface PythonSymbol {
  name: string;
  kind: string;
  line: number;
  character: number;
  preview: string;
  containerName?: string;
}

interface PythonOccurrence {
  name: string;
  line: number;
  character: number;
  preview: string;
}

function resolveFilePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function normalizePreview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 180)}…` : clean;
}

function wordAtLine(text: string, line: number, character: number): string | undefined {
  const lines = text.split(/\r?\n/);
  const current = lines[Math.max(0, line - 1)] ?? "";
  const index = Math.max(0, Math.min(current.length, character - 1));
  const regex = /[A-Za-z_][A-Za-z0-9_]*/g;
  for (const match of current.matchAll(regex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (index >= start && index <= end) return match[0];
  }
  return undefined;
}

function collectPythonSymbols(filePath: string, text: string): PythonSymbol[] {
  const symbols: PythonSymbol[] = [];
  const lines = text.split(/\r?\n/);
  const classStack: Array<{ indent: number; name: string }> = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const indent = (line.match(/^\s*/) ?? [""])[0].length;
    while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) classStack.pop();

    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const leading = line.indexOf(classMatch[1]);
      symbols.push({
        name: classMatch[1],
        kind: "class",
        line: index + 1,
        character: leading + 1,
        preview: normalizePreview(line),
      });
      classStack.push({ indent, name: classMatch[1] });
      continue;
    }

    const defMatch = line.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/);
    if (defMatch) {
      const leading = line.indexOf(defMatch[1]);
      symbols.push({
        name: defMatch[1],
        kind: "function",
        line: index + 1,
        character: leading + 1,
        preview: normalizePreview(line),
        containerName: classStack[classStack.length - 1]?.name,
      });
      continue;
    }

    const assignMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (assignMatch) {
      const leading = line.indexOf(assignMatch[1]);
      symbols.push({
        name: assignMatch[1],
        kind: "variable",
        line: index + 1,
        character: leading + 1,
        preview: normalizePreview(line),
        containerName: classStack[classStack.length - 1]?.name,
      });
      continue;
    }

    const importMatch = line.match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (importMatch) {
      const leading = line.indexOf(importMatch[1]);
      symbols.push({
        name: importMatch[1],
        kind: "module",
        line: index + 1,
        character: leading + 1,
        preview: normalizePreview(line),
      });
      continue;
    }

    const fromImportMatch = line.match(/^\s*from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/);
    if (fromImportMatch) {
      const names = fromImportMatch[2].split(",").map((item) => item.trim()).filter(Boolean);
      for (const name of names) {
        const clean = name.split(/\s+as\s+/i)[0]?.trim();
        if (!clean) continue;
        const leading = line.indexOf(clean);
        symbols.push({
          name: clean,
          kind: "import",
          line: index + 1,
          character: leading + 1,
          preview: normalizePreview(line),
          containerName: fromImportMatch[1],
        });
      }
    }
  }

  return symbols;
}

function collectOccurrences(text: string, name: string): PythonOccurrence[] {
  const occurrences: PythonOccurrence[] = [];
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "g");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const match of line.matchAll(pattern)) {
      occurrences.push({
        name,
        line: index + 1,
        character: (match.index ?? 0) + 1,
        preview: normalizePreview(line),
      });
    }
  }
  return occurrences;
}

function toLocation(filePath: string, item: { line: number; character: number; preview: string }, kind?: string, name?: string): LspLocation {
  return {
    path: filePath,
    line: item.line,
    character: item.character,
    preview: item.preview,
    kind,
    name,
  };
}

function selectedPythonName(cwd: string, params: { path: string; line: number; character: number }): { filePath: string; text: string; name: string } {
  const filePath = resolveFilePath(cwd, params.path);
  const text = fs.readFileSync(filePath, "utf8");
  const name = wordAtLine(text, params.line, params.character);
  if (!name) throw new Error("No Python symbol found at the requested position.");
  return { filePath, text, name };
}

function distinctLocations(locations: LspLocation[]): LspLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.path}:${location.line}:${location.character}:${location.kind ?? ""}:${location.name ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hoverPythonSymbol(cwd: string, params: { path: string; line: number; character: number }): { text: string; display?: string; documentation?: string } {
  const { filePath, text, name } = selectedPythonName(cwd, params);
  const symbols = collectPythonSymbols(filePath, text).filter((symbol) => symbol.name === name);
  const symbol = symbols[0];
  const occurrences = collectOccurrences(text, name).length;
  const lines = [
    symbol ? `${symbol.kind} ${name}` : `symbol ${name}`,
    symbol?.containerName ? `Container: ${symbol.containerName}` : undefined,
    symbol ? `Defined at: ${filePath}:${symbol.line}:${symbol.character}` : undefined,
    `Occurrences in file: ${occurrences}`,
    symbol ? `Preview: ${symbol.preview}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return { text: lines.join("\n"), display: symbol ? `${symbol.kind} ${name}` : name, documentation: symbol?.preview };
}

export function gotoPythonDefinition(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const { filePath, text, name } = selectedPythonName(cwd, params);
  const symbols = collectPythonSymbols(filePath, text).filter((symbol) => symbol.name === name);
  const locations = distinctLocations(symbols.map((symbol) => toLocation(filePath, symbol, symbol.kind, symbol.name)));
  const textOut = locations.length > 0
    ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
    : "No definition found.";
  return { text: textOut, locations };
}

export function findPythonReferences(cwd: string, params: { path: string; line: number; character: number; includeDeclaration?: boolean }): { text: string; locations: LspLocation[] } {
  const { filePath, text, name } = selectedPythonName(cwd, params);
  const symbols = collectPythonSymbols(filePath, text).filter((symbol) => symbol.name === name);
  const definitionKeys = new Set(symbols.map((symbol) => `${symbol.line}:${symbol.character}`));
  const locations = distinctLocations(
    collectOccurrences(text, name)
      .filter((occurrence) => params.includeDeclaration || !definitionKeys.has(`${occurrence.line}:${occurrence.character}`))
      .map((occurrence) => toLocation(filePath, occurrence, definitionKeys.has(`${occurrence.line}:${occurrence.character}`) ? "definition" : "reference", name)),
  );
  const textOut = locations.length > 0
    ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
    : "No references found.";
  return { text: textOut, locations };
}

export function findPythonImplementations(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const { filePath, text, name } = selectedPythonName(cwd, params);
  const lines = text.split(/\r?\n/);
  const implementations: LspLocation[] = [];
  const subclassPattern = new RegExp(`^\\s*class\\s+([A-Za-z_][A-Za-z0-9_]*)\\(([^)]*\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b[^)]*)\\)\\s*:`);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const subclassMatch = line.match(subclassPattern);
    if (subclassMatch) {
      implementations.push(toLocation(filePath, { line: index + 1, character: line.indexOf(subclassMatch[1]) + 1, preview: normalizePreview(line) }, "class", subclassMatch[1]));
    }
  }
  if (implementations.length === 0) {
    return findPythonReferences(cwd, { ...params, includeDeclaration: false });
  }
  const textOut = implementations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n");
  return { text: textOut, locations: implementations };
}

export function getPythonTypeDefinitions(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  return gotoPythonDefinition(cwd, params);
}

export function listPythonSymbols(cwd: string, params: { path?: string; query?: string; maxResults?: number }): { text: string; symbols: LspSymbol[]; projectPath?: string } {
  const filePath = resolveFilePath(cwd, params.path ?? cwd);
  if (!fs.existsSync(filePath)) throw new Error(`Python file not found: ${filePath}`);
  const text = fs.readFileSync(filePath, "utf8");
  const query = params.query?.trim().toLowerCase();
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
  const symbols = collectPythonSymbols(filePath, text)
    .filter((symbol) => !query || `${symbol.name} ${symbol.kind} ${symbol.preview} ${symbol.containerName ?? ""}`.toLowerCase().includes(query))
    .slice(0, maxResults)
    .map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      path: filePath,
      line: symbol.line,
      character: symbol.character,
      preview: symbol.preview,
      containerName: symbol.containerName,
    } satisfies LspSymbol));
  const textOut = symbols.length > 0
    ? symbols.map((symbol, index) => `${index + 1}. ${symbol.path}:${symbol.line}:${symbol.character} [${symbol.kind}] ${symbol.name}${symbol.containerName ? ` (${symbol.containerName})` : ""}\n   ${symbol.preview}`).join("\n")
    : "No symbols found.";
  return { text: textOut, symbols };
}

export function getPythonDiagnostics(cwd: string, params: { path?: string; maxResults?: number }): { text: string; diagnostics: LspDiagnostic[]; projectPath?: string } {
  const filePath = resolveFilePath(cwd, params.path ?? cwd);
  const diagnostics: LspDiagnostic[] = [];
  const source = fs.readFileSync(filePath, "utf8");
  const result = spawnSync("python3", ["-c", "import json, pathlib, py_compile, sys; p=pathlib.Path(sys.argv[1]);\ntry:\n py_compile.compile(str(p), doraise=True)\n print(json.dumps({'ok': True}))\nexcept py_compile.PyCompileError as exc:\n err = exc.exc_value\n print(json.dumps({'ok': False, 'msg': getattr(err, 'msg', str(exc)), 'line': getattr(err, 'lineno', 1), 'offset': getattr(err, 'offset', 1)}))", filePath], { encoding: "utf8" });
  const parsed = (() => {
    try { return JSON.parse(result.stdout || "{}"); } catch { return { ok: false, msg: result.stderr || "Python diagnostics unavailable", line: 1, offset: 1 }; }
  })() as { ok?: boolean; msg?: string; line?: number; offset?: number };

  if (!parsed.ok) {
    diagnostics.push({
      path: filePath,
      line: parsed.line ?? 1,
      character: parsed.offset ?? 1,
      code: 1,
      category: "error",
      message: parsed.msg?.trim() || "Python diagnostics unavailable",
    });
  }

  const textOut = diagnostics.length > 0
    ? diagnostics.map((diagnostic, index) => `${index + 1}. ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} [${diagnostic.category} PY${diagnostic.code}]\n   ${diagnostic.message}`).join("\n")
    : "No diagnostics found.";
  return { text: textOut, diagnostics };
}

function replaceLineRange(text: string, line: number, startChar: number, endChar: number, replacement: string): string {
  const lines = text.split(/\r?\n/);
  const current = lines[line - 1] ?? "";
  lines[line - 1] = `${current.slice(0, startChar - 1)}${replacement}${current.slice(endChar - 1)}`;
  return lines.join("\n");
}

export function renamePythonSymbol(cwd: string, params: { path: string; line: number; character: number; newName: string; apply?: boolean }): { text: string; files: LspRenameFileEdit[] } {
  const { filePath, text, name } = selectedPythonName(cwd, params);
  const occurrences = collectOccurrences(text, name);
  if (occurrences.length === 0) return { text: "No rename locations found.", files: [] };
  if (params.apply) {
    let next = text;
    const ordered = [...occurrences].sort((a, b) => b.line - a.line || b.character - a.character);
    for (const occurrence of ordered) {
      next = replaceLineRange(next, occurrence.line, occurrence.character, occurrence.character + name.length, params.newName);
    }
    fs.writeFileSync(filePath, next);
  }
  const action = params.apply ? "Applied" : "Prepared";
  return {
    text: `${action} rename of '${name}' to '${params.newName}' across 1 file.\n\n- ${filePath} (${occurrences.length} edit${occurrences.length === 1 ? "" : "s"})`,
    files: [{ path: filePath, edits: occurrences.length }],
  };
}
