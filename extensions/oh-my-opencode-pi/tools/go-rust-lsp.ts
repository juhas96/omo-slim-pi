import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LspDiagnostic, LspLocation, LspRenameFileEdit, LspSymbol } from "./lsp.js";

export type NativeLanguage = "go" | "rust";

export interface NativeLanguageCapabilities {
  language: NativeLanguage;
  navigation: "heuristic";
  externalNavigation: {
    command: string;
    available: boolean;
  };
  formatter: {
    command: string;
    available: boolean;
    mode: "external" | "fallback";
  };
  diagnostics: {
    command?: string;
    available: boolean;
    mode: "external" | "heuristic";
  };
  notes: string[];
}

interface NativeSymbol {
  name: string;
  kind: string;
  line: number;
  character: number;
  preview: string;
  containerName?: string;
}

interface NativeOccurrence {
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

function commandAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    return result.status === 0 || Boolean(result.stdout?.trim()) || Boolean(result.stderr?.trim());
  } catch {
    return false;
  }
}

function detectLanguage(filePath: string): NativeLanguage {
  if (/\.go$/i.test(filePath)) return "go";
  if (/\.rs$/i.test(filePath)) return "rust";
  throw new Error(`Unsupported native-language file: ${filePath}`);
}

export function inspectNativeLanguageCapabilities(filePath: string): NativeLanguageCapabilities {
  const language = detectLanguage(filePath);
  if (language === "go") {
    const hasGopls = commandAvailable("gopls");
    const hasGoFmt = commandAvailable("gofmt");
    const hasGo = commandAvailable("go");
    return {
      language,
      navigation: "heuristic",
      externalNavigation: { command: "gopls", available: hasGopls },
      formatter: { command: "gofmt", available: hasGoFmt, mode: hasGoFmt ? "external" : "fallback" },
      diagnostics: { command: "go", available: hasGo, mode: hasGo ? "external" : "heuristic" },
      notes: hasGopls
        ? ["gopls detected; Pantheon can still use heuristic navigation when direct LSP wiring is unavailable."]
        : ["gopls not detected; using heuristic single-file navigation.", "Install gopls for richer workspace-level Go intelligence outside Pantheon's fallback mode."],
    };
  }
  const hasRustAnalyzer = commandAvailable("rust-analyzer");
  const hasRustfmt = commandAvailable("rustfmt");
  const hasRustc = commandAvailable("rustc");
  return {
    language,
    navigation: "heuristic",
    externalNavigation: { command: "rust-analyzer", available: hasRustAnalyzer },
    formatter: { command: "rustfmt", available: hasRustfmt, mode: hasRustfmt ? "external" : "fallback" },
    diagnostics: { command: "rustc", available: hasRustc, mode: hasRustc ? "external" : "heuristic" },
    notes: hasRustAnalyzer
      ? ["rust-analyzer detected; Pantheon still falls back to heuristic navigation when needed."]
      : ["rust-analyzer not detected; using heuristic single-file navigation.", "Install rust-analyzer for richer workspace-level Rust intelligence outside Pantheon's fallback mode."],
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function selectedName(cwd: string, params: { path: string; line: number; character: number }): { filePath: string; text: string; name: string; capabilities: NativeLanguageCapabilities } {
  const filePath = resolveFilePath(cwd, params.path);
  const text = fs.readFileSync(filePath, "utf8");
  const name = wordAtLine(text, params.line, params.character);
  if (!name) throw new Error("No Go/Rust symbol found at the requested position.");
  return { filePath, text, name, capabilities: inspectNativeLanguageCapabilities(filePath) };
}

function collectGoSymbols(filePath: string, text: string): NativeSymbol[] {
  const symbols: NativeSymbol[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const packageMatch = line.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (packageMatch) {
      symbols.push({ name: packageMatch[1], kind: "package", line: index + 1, character: line.indexOf(packageMatch[1]) + 1, preview: normalizePreview(line) });
      continue;
    }
    const typeMatch = line.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(interface|struct)\b/);
    if (typeMatch) {
      symbols.push({ name: typeMatch[1], kind: typeMatch[2], line: index + 1, character: line.indexOf(typeMatch[1]) + 1, preview: normalizePreview(line) });
      continue;
    }
    const aliasMatch = line.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+.+$/);
    if (aliasMatch) {
      symbols.push({ name: aliasMatch[1], kind: "type", line: index + 1, character: line.indexOf(aliasMatch[1]) + 1, preview: normalizePreview(line) });
      continue;
    }
    const funcMatch = line.match(/^\s*func(?:\s*\(([^)]*)\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (funcMatch) {
      const receiver = funcMatch[1]?.trim();
      const kind = receiver ? "method" : "function";
      symbols.push({ name: funcMatch[2], kind, line: index + 1, character: line.indexOf(funcMatch[2]) + 1, preview: normalizePreview(line), containerName: receiver });
      continue;
    }
    const varMatch = line.match(/^\s*(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (varMatch) {
      symbols.push({ name: varMatch[1], kind: line.includes("const") ? "constant" : "variable", line: index + 1, character: line.indexOf(varMatch[1]) + 1, preview: normalizePreview(line) });
      continue;
    }
  }
  return symbols;
}

function collectRustSymbols(filePath: string, text: string): NativeSymbol[] {
  const symbols: NativeSymbol[] = [];
  const lines = text.split(/\r?\n/);
  let implContainer: string | undefined;
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    const implMatch = trimmed.match(/^impl(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_:<>]*)/);
    if (implMatch && trimmed.includes("{")) implContainer = implMatch[1];
    braceDepth += (line.match(/\{/g) ?? []).length;
    braceDepth -= (line.match(/\}/g) ?? []).length;
    if (braceDepth <= 0) implContainer = undefined;

    const moduleMatch = line.match(/^\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (moduleMatch) {
      symbols.push({ name: moduleMatch[1], kind: "module", line: index + 1, character: line.indexOf(moduleMatch[1]) + 1, preview: normalizePreview(line) });
      continue;
    }
    const typeMatch = line.match(/^\s*(?:pub\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (typeMatch) {
      symbols.push({ name: typeMatch[2], kind: typeMatch[1], line: index + 1, character: line.indexOf(typeMatch[2]) + 1, preview: normalizePreview(line) });
      continue;
    }
    const fnMatch = line.match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (fnMatch) {
      symbols.push({ name: fnMatch[1], kind: "function", line: index + 1, character: line.indexOf(fnMatch[1]) + 1, preview: normalizePreview(line), containerName: implContainer });
      continue;
    }
    const constMatch = line.match(/^\s*(?:pub\s+)?(?:const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (constMatch) {
      symbols.push({ name: constMatch[1], kind: line.includes("static") ? "static" : "constant", line: index + 1, character: line.indexOf(constMatch[1]) + 1, preview: normalizePreview(line) });
      continue;
    }
    const letMatch = line.match(/^\s*let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (letMatch) {
      symbols.push({ name: letMatch[1], kind: "variable", line: index + 1, character: line.indexOf(letMatch[1]) + 1, preview: normalizePreview(line), containerName: implContainer });
    }
  }
  return symbols;
}

function collectSymbols(filePath: string, text: string): NativeSymbol[] {
  return detectLanguage(filePath) === "go" ? collectGoSymbols(filePath, text) : collectRustSymbols(filePath, text);
}

function collectOccurrences(text: string, name: string): NativeOccurrence[] {
  const occurrences: NativeOccurrence[] = [];
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const match of line.matchAll(pattern)) {
      occurrences.push({ line: index + 1, character: (match.index ?? 0) + 1, preview: normalizePreview(line) });
    }
  }
  return occurrences;
}

function buildHoverText(name: string, symbol: NativeSymbol | undefined, capabilities: NativeLanguageCapabilities): string {
  return [
    symbol ? `${symbol.kind} ${name}` : `symbol ${name}`,
    symbol?.containerName ? `Container: ${symbol.containerName}` : undefined,
    `Navigation mode: ${capabilities.navigation}`,
    `Formatter: ${capabilities.formatter.mode}${capabilities.formatter.available ? ` (${capabilities.formatter.command})` : ""}`,
    ...capabilities.notes,
    symbol ? `Preview: ${symbol.preview}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function hoverNativeSymbol(cwd: string, params: { path: string; line: number; character: number }): { text: string; display?: string; documentation?: string } {
  const { filePath, text, name, capabilities } = selectedName(cwd, params);
  const symbol = collectSymbols(filePath, text).find((item) => item.name === name);
  return {
    text: buildHoverText(name, symbol, capabilities),
    display: symbol ? `${symbol.kind} ${name}` : name,
    documentation: symbol?.preview,
  };
}

export function gotoNativeDefinition(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const { filePath, text, name } = selectedName(cwd, params);
  const locations = distinctLocations(collectSymbols(filePath, text).filter((item) => item.name === name).map((item) => toLocation(filePath, item, item.kind, item.name)));
  return {
    text: locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
      : "No definition found.",
    locations,
  };
}

export function findNativeReferences(cwd: string, params: { path: string; line: number; character: number; includeDeclaration?: boolean }): { text: string; locations: LspLocation[] } {
  const { filePath, text, name } = selectedName(cwd, params);
  const symbols = collectSymbols(filePath, text).filter((item) => item.name === name);
  const definitionKeys = new Set(symbols.map((item) => `${item.line}:${item.character}`));
  const locations = distinctLocations(
    collectOccurrences(text, name)
      .filter((item) => params.includeDeclaration || !definitionKeys.has(`${item.line}:${item.character}`))
      .map((item) => toLocation(filePath, item, definitionKeys.has(`${item.line}:${item.character}`) ? "definition" : "reference", name)),
  );
  return {
    text: locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
      : "No references found.",
    locations,
  };
}

function findRustImplementations(filePath: string, text: string, name: string): LspLocation[] {
  const lines = text.split(/\r?\n/);
  const locations: LspLocation[] = [];
  const traitPattern = new RegExp(`^\\s*impl(?:<[^>]+>)?\\s+${escapeRegExp(name)}\\s+for\\s+([A-Za-z_][A-Za-z0-9_:<>]*)`);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(traitPattern);
    if (!match) continue;
    const target = match[1];
    locations.push(toLocation(filePath, { line: index + 1, character: line.indexOf(target) + 1, preview: normalizePreview(line) }, "implementation", target));
  }
  return locations;
}

export function findNativeImplementations(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const { filePath, text, name } = selectedName(cwd, params);
  const language = detectLanguage(filePath);
  let locations = language === "rust" ? findRustImplementations(filePath, text, name) : [];
  if (locations.length === 0) {
    locations = findNativeReferences(cwd, { ...params, includeDeclaration: false }).locations;
  }
  return {
    text: locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
      : "No implementations found.",
    locations,
  };
}

export function getNativeTypeDefinitions(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  return gotoNativeDefinition(cwd, params);
}

function unmatchedBraceDiagnostic(filePath: string, text: string, language: NativeLanguage): LspDiagnostic[] {
  const stack: Array<{ char: string; line: number; character: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (let charIndex = 0; charIndex < line.length; charIndex++) {
      const char = line[charIndex];
      if (char === "{") stack.push({ char, line: lineIndex + 1, character: charIndex + 1 });
      if (char === "}") {
        const open = stack.pop();
        if (!open) {
          return [{ path: filePath, line: lineIndex + 1, character: charIndex + 1, code: 1, category: "error", message: `${language} syntax appears to have an unmatched closing brace.` }];
        }
      }
    }
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    return [{ path: filePath, line: open.line, character: open.character, code: 1, category: "error", message: `${language} syntax appears to have an unmatched opening brace.` }];
  }
  return [];
}

function runGoDiagnostics(filePath: string): LspDiagnostic[] {
  const result = spawnSync("go", ["build", filePath], { encoding: "utf8" });
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (result.status === 0 || !output) return [];
  const match = output.match(/:(\d+):(\d+):\s*(.+)$/m);
  return [{
    path: filePath,
    line: Number(match?.[1] ?? 1),
    character: Number(match?.[2] ?? 1),
    code: 1,
    category: "error",
    message: match?.[3]?.trim() || output,
  }];
}

function runRustDiagnostics(filePath: string): LspDiagnostic[] {
  const result = spawnSync("rustc", ["--crate-type", "lib", filePath], { encoding: "utf8" });
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (result.status === 0 || !output) return [];
  const match = output.match(/-->\s+.*:(\d+):(\d+)/);
  const message = output.split(/\r?\n/).find((line) => /^error/i.test(line.trim())) ?? output;
  return [{
    path: filePath,
    line: Number(match?.[1] ?? 1),
    character: Number(match?.[2] ?? 1),
    code: 1,
    category: "error",
    message: message.trim(),
  }];
}

export function getNativeDiagnostics(cwd: string, params: { path?: string; maxResults?: number }): { text: string; diagnostics: LspDiagnostic[]; projectPath?: string; capabilities: NativeLanguageCapabilities } {
  const filePath = resolveFilePath(cwd, params.path ?? cwd);
  const text = fs.readFileSync(filePath, "utf8");
  const language = detectLanguage(filePath);
  const capabilities = inspectNativeLanguageCapabilities(filePath);
  let diagnostics = unmatchedBraceDiagnostic(filePath, text, language);
  if (diagnostics.length === 0) {
    if (language === "go") {
      if (!/^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\b/m.test(text)) {
        diagnostics = [{ path: filePath, line: 1, character: 1, code: 2, category: "error", message: "Go files should declare a package." }];
      } else if (capabilities.diagnostics.available) {
        diagnostics = runGoDiagnostics(filePath);
      }
    } else if (capabilities.diagnostics.available) {
      diagnostics = runRustDiagnostics(filePath);
    }
  }
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
  diagnostics = diagnostics.slice(0, maxResults);
  const header = `Diagnostics mode: ${capabilities.diagnostics.mode}${capabilities.diagnostics.command ? ` (${capabilities.diagnostics.command})` : ""}`;
  return {
    text: diagnostics.length > 0
      ? `${header}\n\n${diagnostics.map((diagnostic, index) => `${index + 1}. ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} [${diagnostic.category} ${capabilities.language.toUpperCase()}${diagnostic.code}]\n   ${diagnostic.message}`).join("\n")}`
      : `${header}\n\nNo diagnostics found.`,
    diagnostics,
    capabilities,
  };
}

export function listNativeSymbols(cwd: string, params: { path?: string; query?: string; maxResults?: number }): { text: string; symbols: LspSymbol[]; projectPath?: string; capabilities: NativeLanguageCapabilities } {
  const filePath = resolveFilePath(cwd, params.path ?? cwd);
  const text = fs.readFileSync(filePath, "utf8");
  const query = params.query?.trim().toLowerCase();
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
  const capabilities = inspectNativeLanguageCapabilities(filePath);
  const symbols = collectSymbols(filePath, text)
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
  const header = `Navigation mode: ${capabilities.navigation}`;
  return {
    text: symbols.length > 0
      ? `${header}\n\n${symbols.map((symbol, index) => `${index + 1}. ${symbol.path}:${symbol.line}:${symbol.character} [${symbol.kind}] ${symbol.name}${symbol.containerName ? ` (${symbol.containerName})` : ""}\n   ${symbol.preview}`).join("\n")}`
      : `${header}\n\nNo symbols found.`,
    symbols,
    capabilities,
  };
}

function replaceLineRange(text: string, line: number, startChar: number, endChar: number, replacement: string): string {
  const lines = text.split(/\r?\n/);
  const current = lines[line - 1] ?? "";
  lines[line - 1] = `${current.slice(0, startChar - 1)}${replacement}${current.slice(endChar - 1)}`;
  return lines.join("\n");
}

export function renameNativeSymbol(cwd: string, params: { path: string; line: number; character: number; newName: string; apply?: boolean }): { text: string; files: LspRenameFileEdit[] } {
  const { filePath, text, name } = selectedName(cwd, params);
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

function fallbackFormat(text: string): string {
  const trimmedLines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  return `${trimmedLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function runFormatter(command: string, args: string[]): string | undefined {
  try {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout;
    return undefined;
  } catch {
    return undefined;
  }
}

export function formatNativeDocument(cwd: string, params: { path: string; apply?: boolean }): { path: string; changed: boolean; text: string; capabilities: NativeLanguageCapabilities } {
  const filePath = resolveFilePath(cwd, params.path);
  const sourceText = fs.readFileSync(filePath, "utf8");
  const capabilities = inspectNativeLanguageCapabilities(filePath);
  let nextText = sourceText;

  if (capabilities.language === "go" && capabilities.formatter.available) {
    nextText = runFormatter("gofmt", [filePath]) ?? fallbackFormat(sourceText);
  } else if (capabilities.language === "rust" && capabilities.formatter.available) {
    nextText = runFormatter("rustfmt", ["--emit", "stdout", filePath]) ?? fallbackFormat(sourceText);
  } else {
    nextText = fallbackFormat(sourceText);
  }

  if (params.apply) fs.writeFileSync(filePath, nextText);
  const changed = nextText !== sourceText;
  const mode = capabilities.formatter.mode;
  return {
    path: filePath,
    changed,
    text: changed
      ? `${params.apply ? "Applied" : "Prepared"} ${mode} formatting for ${filePath}.`
      : `No formatting changes needed for ${filePath}.`,
    capabilities,
  };
}
