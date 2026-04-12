import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  findNodeAtLocation,
  findNodeAtOffset,
  getNodePath,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import * as ts from "typescript";
import {
  findPythonImplementations,
  findPythonReferences,
  getPythonDiagnostics,
  getPythonTypeDefinitions,
  gotoPythonDefinition,
  hoverPythonSymbol,
  listPythonSymbols,
  renamePythonSymbol,
} from "./python-lsp.js";
import {
  findNativeImplementations,
  findNativeReferences,
  getNativeDiagnostics,
  getNativeTypeDefinitions,
  gotoNativeDefinition,
  hoverNativeSymbol,
  listNativeSymbols,
  renameNativeSymbol,
} from "./go-rust-lsp.js";

export const LspPositionParams = Type.Object({
  path: Type.String({ description: "Project-relative or absolute file path." }),
  line: Type.Number({ description: "1-indexed line number." }),
  character: Type.Number({ description: "1-indexed character number." }),
});

export const LspReferencesParams = Type.Object({
  path: Type.String({ description: "Project-relative or absolute file path." }),
  line: Type.Number({ description: "1-indexed line number." }),
  character: Type.Number({ description: "1-indexed character number." }),
  includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration in the reference list.", default: false })),
});

export const LspDiagnosticsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional file path. Omit to inspect the nearest supported project/file." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum diagnostics to return.", default: 100 })),
});

export const LspSymbolsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional file path. Omit to use the nearest supported project file." })),
  query: Type.Optional(Type.String({ description: "Optional symbol query. When provided, runs a workspace-style symbol search." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum symbols to return.", default: 100 })),
});

export const LspRenameParams = Type.Object({
  path: Type.String({ description: "Project-relative or absolute file path." }),
  line: Type.Number({ description: "1-indexed line number." }),
  character: Type.Number({ description: "1-indexed character number." }),
  newName: Type.String({ description: "Replacement symbol name." }),
  apply: Type.Optional(Type.Boolean({ description: "Apply edits to disk. Default false previews only.", default: false })),
});

export interface LspLocation {
  path: string;
  line: number;
  character: number;
  preview: string;
  kind?: string;
  name?: string;
}

export interface LspDiagnostic {
  path: string;
  line: number;
  character: number;
  code: number;
  category: string;
  message: string;
}

export interface LspRenameFileEdit {
  path: string;
  edits: number;
}

export interface LspSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  character: number;
  preview: string;
  containerName?: string;
}

interface ProjectContext {
  service: ts.LanguageService;
  filePath: string;
  fileNames: string[];
  projectDir: string;
  configPath?: string;
  dispose(): void;
}

interface JsonDocumentContext {
  filePath: string;
  text: string;
  root?: JsonNode;
  errors: ParseError[];
}

interface JsonSelection {
  offset: number;
  node?: JsonNode;
  property?: JsonNode;
  keyNode?: JsonNode;
  valueNode?: JsonNode;
  onKey: boolean;
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

function isTsLikeFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(filePath);
}

function isJsonLikeFile(filePath: string): boolean {
  return /\.(json|jsonc)$/i.test(filePath);
}

function isPythonFile(filePath: string): boolean {
  return /\.py$/i.test(filePath);
}

function isGoFile(filePath: string): boolean {
  return /\.go$/i.test(filePath);
}

function isRustFile(filePath: string): boolean {
  return /\.rs$/i.test(filePath);
}

function isSupportedFile(filePath: string): boolean {
  return isTsLikeFile(filePath) || isJsonLikeFile(filePath) || isPythonFile(filePath) || isGoFile(filePath) || isRustFile(filePath);
}

function resolveFilePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function normalizePreview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 180)}…` : clean;
}

function getLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function getLineInfo(text: string, position: number): { line: number; character: number; preview: string } {
  const lineStarts = getLineStarts(text);
  let lineIndex = 0;
  while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= position) lineIndex++;
  const lineStart = lineStarts[lineIndex] ?? 0;
  const nextStart = lineStarts[lineIndex + 1] ?? text.length;
  const lineText = text.slice(lineStart, nextStart);
  const char = position - lineStart;
  return {
    line: lineIndex + 1,
    character: char + 1,
    preview: normalizePreview(lineText),
  };
}

function toOffset(text: string, line: number, character: number): number {
  const requestedLine = Math.max(1, Math.floor(line));
  const requestedCharacter = Math.max(1, Math.floor(character));
  const lineStarts = getLineStarts(text);
  const lineIndex = Math.min(requestedLine - 1, Math.max(0, lineStarts.length - 1));
  const lineStart = lineStarts[lineIndex] ?? 0;
  const nextLineStart = lineStarts[lineIndex + 1] ?? text.length;
  return Math.min(nextLineStart, lineStart + requestedCharacter - 1);
}

function locationFromOffset(filePath: string, text: string, offset: number, kind?: string, name?: string): LspLocation {
  const info = getLineInfo(text, offset);
  return {
    path: filePath,
    line: info.line,
    character: info.character,
    preview: info.preview,
    kind,
    name,
  };
}

function createProjectContext(cwd: string, requestedPath?: string): ProjectContext {
  const absolutePath = resolveFilePath(cwd, requestedPath ?? cwd);
  const targetDir = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory() ? absolutePath : path.dirname(absolutePath);
  const configPath = ts.findConfigFile(targetDir, ts.sys.fileExists, "tsconfig.json")
    ?? ts.findConfigFile(targetDir, ts.sys.fileExists, "jsconfig.json");

  let filePath = absolutePath;
  let fileNames: string[] = [];
  let projectDir = targetDir;
  let compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };

  if (configPath) {
    const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configResult.error) {
      throw new Error(ts.flattenDiagnosticMessageText(configResult.error.messageText, "\n"));
    }
    const parsed = ts.parseJsonConfigFileContent(configResult.config, ts.sys, path.dirname(configPath));
    if (parsed.errors.length > 0) {
      throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
    }
    fileNames = [...parsed.fileNames];
    compilerOptions = {
      ...compilerOptions,
      ...parsed.options,
    };
    projectDir = path.dirname(configPath);
    if (!requestedPath) {
      filePath = parsed.fileNames.find((name) => isTsLikeFile(name) && !name.includes(`${path.sep}node_modules${path.sep}`)) ?? parsed.fileNames[0] ?? absolutePath;
    }
  }

  if (!fileNames.includes(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    fileNames.push(filePath);
  }

  if (!isTsLikeFile(filePath)) {
    throw new Error(`Unsupported file for Pantheon TS/JS LSP tooling: ${filePath}`);
  }

  const versions = new Map<string, string>();
  const getVersion = (name: string): string => {
    try {
      const stat = fs.statSync(name);
      const version = `${stat.mtimeMs}:${stat.size}`;
      versions.set(name, version);
      return version;
    } catch {
      return versions.get(name) ?? "0";
    }
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => fileNames,
    getScriptVersion: getVersion,
    getScriptSnapshot: (name) => {
      if (!fs.existsSync(name)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(name, "utf8"));
    },
    getCurrentDirectory: () => projectDir,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    service,
    filePath,
    fileNames,
    projectDir,
    configPath: configPath ?? undefined,
    dispose: () => service.dispose(),
  };
}

function locationFromTextSpan(filePath: string, textSpan: ts.TextSpan, kind?: string, name?: string): LspLocation {
  const text = fs.readFileSync(filePath, "utf8");
  return locationFromOffset(filePath, text, textSpan.start, kind, name);
}

function diagnosticCategoryName(category: ts.DiagnosticCategory): string {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "unknown";
  }
}

function displayPartsToText(parts: readonly ts.SymbolDisplayPart[] | undefined): string {
  return ts.displayPartsToString(parts ? [...parts] : []);
}

function symbolKindName(kind: string | undefined): string {
  return (kind ?? "symbol").replace(/Element$/, "");
}

function hoverTypeScriptSymbol(cwd: string, params: { path: string; line: number; character: number }): { text: string; display?: string; documentation?: string } {
  const context = createProjectContext(cwd, params.path);
  try {
    const text = fs.readFileSync(context.filePath, "utf8");
    const position = toOffset(text, params.line, params.character);
    const quickInfo = context.service.getQuickInfoAtPosition(context.filePath, position);
    if (!quickInfo) return { text: "No hover information found." };
    const display = displayPartsToText(quickInfo.displayParts);
    const documentation = displayPartsToText(quickInfo.documentation);
    const tags = (quickInfo.tags ?? []).map((tag) => `@${tag.name} ${displayPartsToText(tag.text)}`.trim()).filter(Boolean);
    const sections = [display || "(no signature)", documentation ? `\n${documentation}` : undefined, tags.length > 0 ? `\n${tags.join("\n")}` : undefined].filter((value): value is string => Boolean(value));
    return { text: sections.join("\n"), display, documentation };
  } finally {
    context.dispose();
  }
}

function gotoTypeScriptDefinition(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const context = createProjectContext(cwd, params.path);
  try {
    const text = fs.readFileSync(context.filePath, "utf8");
    const position = toOffset(text, params.line, params.character);
    const definitionInfo = context.service.getDefinitionAndBoundSpan(context.filePath, position);
    const definitions = definitionInfo?.definitions ?? context.service.getDefinitionAtPosition(context.filePath, position) ?? [];
    const locations = definitions.map((definition) => locationFromTextSpan(definition.fileName, definition.textSpan, definition.kind, definition.name));
    const body = locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
      : "No definition found.";
    return { text: body, locations };
  } finally {
    context.dispose();
  }
}

function findTypeScriptReferences(cwd: string, params: { path: string; line: number; character: number; includeDeclaration?: boolean }): { text: string; locations: LspLocation[] } {
  const context = createProjectContext(cwd, params.path);
  try {
    const text = fs.readFileSync(context.filePath, "utf8");
    const position = toOffset(text, params.line, params.character);
    const references = context.service.findReferences(context.filePath, position) ?? [];
    const locations = references.flatMap((entry) => entry.references)
      .filter((reference) => params.includeDeclaration || !reference.isDefinition)
      .map((reference) => locationFromTextSpan(reference.fileName, reference.textSpan));
    const body = locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}\n   ${location.preview}`).join("\n")
      : "No references found.";
    return { text: body, locations };
  } finally {
    context.dispose();
  }
}

function findTypeScriptImplementations(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const context = createProjectContext(cwd, params.path);
  try {
    const text = fs.readFileSync(context.filePath, "utf8");
    const position = toOffset(text, params.line, params.character);
    const implementations = context.service.getImplementationAtPosition(context.filePath, position) ?? [];
    const locations = implementations.map((item) => locationFromTextSpan(item.fileName, item.textSpan, item.kind));
    const body = locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
      : "No implementations found.";
    return { text: body, locations };
  } finally {
    context.dispose();
  }
}

function getTypeScriptTypeDefinitions(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const context = createProjectContext(cwd, params.path);
  try {
    const text = fs.readFileSync(context.filePath, "utf8");
    const position = toOffset(text, params.line, params.character);
    const definitions = context.service.getTypeDefinitionAtPosition(context.filePath, position) ?? [];
    const locations = definitions.map((item) => locationFromTextSpan(item.fileName, item.textSpan, item.kind, item.name));
    const body = locations.length > 0
      ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
      : "No type definitions found.";
    return { text: body, locations };
  } finally {
    context.dispose();
  }
}

function flattenNavigationTree(filePath: string, sourceText: string, items: readonly ts.NavigationTree[], symbols: LspSymbol[], maxResults: number, containerName?: string): void {
  for (const item of items) {
    if (symbols.length >= maxResults) return;
    const span = item.spans?.[0];
    if (span) {
      const info = getLineInfo(sourceText, span.start);
      symbols.push({
        name: item.text,
        kind: symbolKindName(item.kind),
        path: filePath,
        line: info.line,
        character: info.character,
        preview: info.preview,
        containerName,
      });
    }
    if (item.childItems?.length) flattenNavigationTree(filePath, sourceText, item.childItems, symbols, maxResults, item.text);
  }
}

function listTypeScriptSymbols(cwd: string, params: { path?: string; query?: string; maxResults?: number }): { text: string; symbols: LspSymbol[]; projectPath?: string } {
  const context = createProjectContext(cwd, params.path);
  try {
    const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
    let symbols: LspSymbol[] = [];
    if (params.query?.trim()) {
      symbols = (context.service.getNavigateToItems(params.query.trim(), undefined, undefined, false) ?? [])
        .slice(0, maxResults)
        .map((item) => {
          const text = fs.readFileSync(item.fileName, "utf8");
          const info = getLineInfo(text, item.textSpan.start);
          return {
            name: item.name,
            kind: symbolKindName(item.kind),
            path: item.fileName,
            line: info.line,
            character: info.character,
            preview: info.preview,
            containerName: item.containerName || undefined,
          };
        });
    } else {
      const sourceText = fs.readFileSync(context.filePath, "utf8");
      const tree = context.service.getNavigationTree(context.filePath);
      flattenNavigationTree(context.filePath, sourceText, tree.childItems ?? [], symbols, maxResults);
    }
    const text = symbols.length > 0
      ? symbols.map((symbol, index) => `${index + 1}. ${symbol.path}:${symbol.line}:${symbol.character} [${symbol.kind}] ${symbol.name}${symbol.containerName ? ` (${symbol.containerName})` : ""}\n   ${symbol.preview}`).join("\n")
      : "No symbols found.";
    return { text, symbols, projectPath: context.configPath };
  } finally {
    context.dispose();
  }
}

function getTypeScriptDiagnostics(cwd: string, params: { path?: string; maxResults?: number }): { text: string; diagnostics: LspDiagnostic[]; projectPath?: string } {
  const context = createProjectContext(cwd, params.path);
  try {
    const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
    const candidateFiles = params.path
      ? [context.filePath]
      : context.fileNames.filter((filePath) => isTsLikeFile(filePath) && !filePath.includes(`${path.sep}node_modules${path.sep}`));

    const diagnostics: LspDiagnostic[] = [];
    for (const filePath of candidateFiles) {
      const allDiagnostics = [
        ...context.service.getSyntacticDiagnostics(filePath),
        ...context.service.getSemanticDiagnostics(filePath),
        ...context.service.getSuggestionDiagnostics(filePath),
      ];
      for (const diagnostic of allDiagnostics) {
        const file = diagnostic.file;
        const start = diagnostic.start ?? 0;
        const info = file ? getLineInfo(file.text, start) : { line: 1, character: 1, preview: "" };
        diagnostics.push({
          path: filePath,
          line: info.line,
          character: info.character,
          code: diagnostic.code,
          category: diagnosticCategoryName(diagnostic.category),
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        });
        if (diagnostics.length >= maxResults) break;
      }
      if (diagnostics.length >= maxResults) break;
    }

    const text = diagnostics.length > 0
      ? diagnostics.map((diagnostic, index) => `${index + 1}. ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} [${diagnostic.category} TS${diagnostic.code}]\n   ${diagnostic.message}`).join("\n")
      : "No diagnostics found.";
    return { text, diagnostics, projectPath: context.configPath };
  } finally {
    context.dispose();
  }
}

function renameTypeScriptSymbol(cwd: string, params: { path: string; line: number; character: number; newName: string; apply?: boolean }): { text: string; files: LspRenameFileEdit[] } {
  const context = createProjectContext(cwd, params.path);
  try {
    const sourceText = fs.readFileSync(context.filePath, "utf8");
    const position = toOffset(sourceText, params.line, params.character);
    const renameInfo = context.service.getRenameInfo(context.filePath, position, { allowRenameOfImportPath: false });
    if (!renameInfo.canRename) {
      throw new Error(renameInfo.localizedErrorMessage || "Symbol cannot be renamed.");
    }
    const locations = context.service.findRenameLocations(context.filePath, position, false, false, true) ?? [];
    if (locations.length === 0) {
      return { text: "No rename locations found.", files: [] };
    }

    const grouped = new Map<string, ts.RenameLocation[]>();
    for (const location of locations) {
      const existing = grouped.get(location.fileName) ?? [];
      existing.push(location);
      grouped.set(location.fileName, existing);
    }

    const files = [...grouped.entries()].map(([filePath, entries]) => ({ path: filePath, edits: entries.length }));

    if (params.apply) {
      for (const [filePath, entries] of grouped.entries()) {
        let text = fs.readFileSync(filePath, "utf8");
        const ordered = [...entries].sort((a, b) => b.textSpan.start - a.textSpan.start);
        for (const entry of ordered) {
          const replacement = `${entry.prefixText ?? ""}${params.newName}${entry.suffixText ?? ""}`;
          text = `${text.slice(0, entry.textSpan.start)}${replacement}${text.slice(entry.textSpan.start + entry.textSpan.length)}`;
        }
        fs.writeFileSync(filePath, text);
      }
    }

    const action = params.apply ? "Applied" : "Prepared";
    const text = `${action} rename of '${renameInfo.displayName}' to '${params.newName}' across ${files.length} file${files.length === 1 ? "" : "s"}.\n\n${files.map((file) => `- ${file.path} (${file.edits} edit${file.edits === 1 ? "" : "s"})`).join("\n")}`;
    return { text, files };
  } finally {
    context.dispose();
  }
}

function pickDefaultJsonFile(cwd: string): string {
  const candidates = [
    path.join(cwd, "package.json"),
    path.join(cwd, ".pi", "oh-my-opencode-pi.jsonc"),
    path.join(cwd, ".pi", "oh-my-opencode-pi.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    throw new Error(`No JSON/JSONC file found in ${cwd}`);
  }
  const fallback = entries
    .filter((entry) => /\.(json|jsonc)$/i.test(entry))
    .map((entry) => path.join(cwd, entry))
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!fallback) throw new Error(`No JSON/JSONC file found in ${cwd}`);
  return fallback;
}

function createJsonDocumentContext(cwd: string, requestedPath?: string): JsonDocumentContext {
  const absolutePath = requestedPath ? resolveFilePath(cwd, requestedPath) : pickDefaultJsonFile(cwd);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`JSON/JSONC file not found: ${absolutePath}`);
  }
  if (!isJsonLikeFile(absolutePath)) {
    throw new Error(`Unsupported file for Pantheon JSON LSP tooling: ${absolutePath}`);
  }
  const text = fs.readFileSync(absolutePath, "utf8");
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  return { filePath: absolutePath, text, root, errors };
}

function getJsonSelection(doc: JsonDocumentContext, params: { line: number; character: number }): JsonSelection {
  const offset = toOffset(doc.text, params.line, params.character);
  const node = doc.root ? findNodeAtOffset(doc.root, offset, true) ?? findNodeAtOffset(doc.root, Math.max(0, offset - 1), true) : undefined;
  const property = node?.type === "property" ? node : node?.parent?.type === "property" ? node.parent : undefined;
  const keyNode = property?.children?.[0];
  const valueNode = property?.children?.[1];
  const onKey = Boolean(keyNode && offset >= keyNode.offset && offset <= keyNode.offset + keyNode.length);
  return { offset, node, property, keyNode, valueNode, onKey };
}

function getJsonPropertyName(property: JsonNode | undefined): string | undefined {
  return property?.children?.[0]?.value;
}

function getJsonEffectiveNode(node: JsonNode | undefined): JsonNode | undefined {
  if (!node) return undefined;
  if (node.type === "property") return node.children?.[1] ?? node.children?.[0] ?? node;
  return node;
}

function jsonLocationFromNode(doc: JsonDocumentContext, node: JsonNode | undefined, kind?: string, name?: string): LspLocation | undefined {
  if (!node) return undefined;
  const target = node.type === "property" ? node.children?.[0] ?? node : node;
  return locationFromOffset(doc.filePath, doc.text, target.offset, kind, name);
}

function formatJsonPath(pathValue: Array<string | number>): string {
  if (pathValue.length === 0) return "$";
  return `$${pathValue.map((segment) => (typeof segment === "number" ? `[${segment}]` : /^[A-Za-z_$][\w$-]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)).join("")}`;
}

function escapeJsonPointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

function toJsonPointer(pathValue: Array<string | number>): string {
  if (pathValue.length === 0) return "#";
  return `#/${pathValue.map(escapeJsonPointerSegment).join("/")}`;
}

function parseJsonPointer(ref: string): Array<string | number> | undefined {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").filter(Boolean).map((segment) => {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function isJsonRefProperty(property: JsonNode | undefined): boolean {
  return getJsonPropertyName(property) === "$ref";
}

function resolveJsonRefNode(doc: JsonDocumentContext, ref: string): JsonNode | undefined {
  if (!doc.root) return undefined;
  const pointer = parseJsonPointer(ref);
  if (!pointer) return undefined;
  return findNodeAtLocation(doc.root, pointer);
}

function walkJsonNodes(node: JsonNode | undefined, visit: (node: JsonNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walkJsonNodes(child, visit);
}

function collectJsonPropertyNodes(root: JsonNode | undefined): JsonNode[] {
  const properties: JsonNode[] = [];
  walkJsonNodes(root, (node) => {
    if (node.type === "property") properties.push(node);
  });
  return properties;
}

function collectJsonRefNodes(root: JsonNode | undefined): Array<{ property: JsonNode; valueNode: JsonNode; ref: string }> {
  const refs: Array<{ property: JsonNode; valueNode: JsonNode; ref: string }> = [];
  for (const property of collectJsonPropertyNodes(root)) {
    const key = getJsonPropertyName(property);
    const valueNode = property.children?.[1];
    if (key === "$ref" && valueNode?.type === "string" && typeof valueNode.value === "string") {
      refs.push({ property, valueNode, ref: valueNode.value });
    }
  }
  return refs;
}

function findJsonObjectProperty(node: JsonNode | undefined, key: string): JsonNode | undefined {
  const target = getJsonEffectiveNode(node);
  if (!target || target.type !== "object") return undefined;
  return (target.children ?? []).find((child) => child.type === "property" && getJsonPropertyName(child) === key);
}

function inferJsonSymbolKind(property: JsonNode): string {
  const valueNode = property.children?.[1];
  if (!valueNode) return "property";
  if (valueNode.type === "object") {
    const typeProperty = findJsonObjectProperty(valueNode, "type");
    const typeValue = typeProperty?.children?.[1];
    if (typeValue?.type === "string" && typeof typeValue.value === "string") return `schema:${typeValue.value}`;
    if (findJsonObjectProperty(valueNode, "$ref")) return "schema:ref";
  }
  return valueNode.type;
}

function buildJsonHover(doc: JsonDocumentContext, selection: JsonSelection): { text: string; display?: string; documentation?: string } {
  const target = selection.property ?? selection.node;
  if (!target) return { text: "No hover information found." };

  const propertyName = getJsonPropertyName(selection.property);
  const effectiveNode = selection.valueNode ?? getJsonEffectiveNode(selection.node);
  const jsonPath = effectiveNode ? formatJsonPath(getNodePath(effectiveNode)) : "$";
  const valueType = effectiveNode?.type ?? target.type;
  const previewValue = effectiveNode?.type === "object" || effectiveNode?.type === "array"
    ? normalizePreview(doc.text.slice(effectiveNode.offset, effectiveNode.offset + effectiveNode.length))
    : normalizePreview(JSON.stringify(effectiveNode?.value ?? propertyName ?? null));
  const refValue = isJsonRefProperty(selection.property) && selection.valueNode?.type === "string" && typeof selection.valueNode.value === "string"
    ? selection.valueNode.value
    : undefined;
  const refTarget = refValue ? resolveJsonRefNode(doc, refValue) : undefined;
  const refTargetPath = refTarget ? formatJsonPath(getNodePath(refTarget)) : undefined;

  const lines = [
    propertyName ? `Property: ${propertyName}` : `Kind: ${target.type}`,
    `JSON path: ${jsonPath}`,
    `Value type: ${valueType}`,
    refValue ? `Reference: ${refValue}` : undefined,
    refTargetPath ? `Resolves to: ${refTargetPath}` : undefined,
    `Preview: ${previewValue}`,
  ].filter((line): line is string => Boolean(line));

  return {
    text: lines.join("\n"),
    display: propertyName ? `property ${propertyName}` : target.type,
    documentation: refTargetPath ? `Reference target: ${refTargetPath}` : `JSON node at ${jsonPath}`,
  };
}

function gotoJsonDefinition(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const doc = createJsonDocumentContext(cwd, params.path);
  const selection = getJsonSelection(doc, params);
  const locations: LspLocation[] = [];

  if (isJsonRefProperty(selection.property) && selection.valueNode?.type === "string" && typeof selection.valueNode.value === "string") {
    const refTarget = resolveJsonRefNode(doc, selection.valueNode.value);
    const location = jsonLocationFromNode(doc, refTarget, "json-ref-target", selection.valueNode.value);
    if (location) locations.push(location);
  }

  if (locations.length === 0) {
    const location = jsonLocationFromNode(doc, selection.property ?? selection.node, selection.property ? "property" : selection.node?.type, getJsonPropertyName(selection.property));
    if (location) locations.push(location);
  }

  const text = locations.length > 0
    ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
    : "No definition found.";
  return { text, locations };
}

function findJsonReferences(cwd: string, params: { path: string; line: number; character: number; includeDeclaration?: boolean }): { text: string; locations: LspLocation[] } {
  const doc = createJsonDocumentContext(cwd, params.path);
  const selection = getJsonSelection(doc, params);
  const locations: LspLocation[] = [];
  const seen = new Set<string>();
  const pushLocation = (location: LspLocation | undefined) => {
    if (!location) return;
    const key = `${location.path}:${location.line}:${location.character}:${location.kind ?? ""}:${location.name ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(location);
  };

  const selectedPointer = selection.valueNode ? toJsonPointer(getNodePath(selection.valueNode)) : undefined;
  const definitionLocation = jsonLocationFromNode(doc, selection.property, "property", getJsonPropertyName(selection.property));
  const refs = collectJsonRefNodes(doc.root);

  if (isJsonRefProperty(selection.property) && selection.valueNode?.type === "string" && typeof selection.valueNode.value === "string") {
    const ref = selection.valueNode.value;
    if (params.includeDeclaration) {
      const target = resolveJsonRefNode(doc, ref);
      pushLocation(jsonLocationFromNode(doc, target, "json-ref-target", ref));
    }
    for (const item of refs) {
      if (item.ref === ref) pushLocation(jsonLocationFromNode(doc, item.valueNode, "json-ref", item.ref));
    }
  } else if (selectedPointer && refs.some((item) => item.ref === selectedPointer)) {
    if (params.includeDeclaration) pushLocation(definitionLocation);
    for (const item of refs) {
      if (item.ref === selectedPointer) pushLocation(jsonLocationFromNode(doc, item.valueNode, "json-ref", item.ref));
    }
  } else {
    const propertyName = getJsonPropertyName(selection.property);
    if (propertyName) {
      if (params.includeDeclaration) pushLocation(definitionLocation);
      for (const property of collectJsonPropertyNodes(doc.root)) {
        if (!params.includeDeclaration && property === selection.property) continue;
        if (getJsonPropertyName(property) === propertyName) pushLocation(jsonLocationFromNode(doc, property, "property", propertyName));
      }
    }
  }

  const text = locations.length > 0
    ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
    : "No references found.";
  return { text, locations };
}

function findJsonImplementations(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const references = findJsonReferences(cwd, { ...params, includeDeclaration: false });
  const text = references.locations.length > 0
    ? references.text
    : "JSON/JSONC implementation lookup falls back to matching references (for example, $ref usages). No implementations found.";
  return { text, locations: references.locations };
}

function getJsonTypeDefinitions(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const doc = createJsonDocumentContext(cwd, params.path);
  const selection = getJsonSelection(doc, params);
  const locations: LspLocation[] = [];

  if (isJsonRefProperty(selection.property) && selection.valueNode?.type === "string" && typeof selection.valueNode.value === "string") {
    const target = resolveJsonRefNode(doc, selection.valueNode.value);
    const location = jsonLocationFromNode(doc, target, "json-ref-target", selection.valueNode.value);
    if (location) locations.push(location);
  } else {
    const container = selection.valueNode?.type === "object"
      ? selection.valueNode
      : selection.property?.parent?.parent?.type === "object"
        ? selection.property.parent.parent
        : undefined;
    const typeProperty = findJsonObjectProperty(container, "$ref") ?? findJsonObjectProperty(container, "type");
    if (typeProperty) {
      const kind = getJsonPropertyName(typeProperty) === "$ref" ? "json-ref" : "json-type";
      const location = jsonLocationFromNode(doc, typeProperty, kind, getJsonPropertyName(typeProperty));
      if (location) locations.push(location);
      if (getJsonPropertyName(typeProperty) === "$ref") {
        const valueNode = typeProperty.children?.[1];
        if (valueNode?.type === "string" && typeof valueNode.value === "string") {
          const target = resolveJsonRefNode(doc, valueNode.value);
          const targetLocation = jsonLocationFromNode(doc, target, "json-ref-target", valueNode.value);
          if (targetLocation) locations.push(targetLocation);
        }
      }
    }
  }

  const text = locations.length > 0
    ? locations.map((location, index) => `${index + 1}. ${location.path}:${location.line}:${location.character}${location.kind ? ` [${location.kind}]` : ""}\n   ${location.preview}`).join("\n")
    : "No type definitions found.";
  return { text, locations };
}

function listJsonSymbols(cwd: string, params: { path?: string; query?: string; maxResults?: number }): { text: string; symbols: LspSymbol[]; projectPath?: string } {
  const doc = createJsonDocumentContext(cwd, params.path);
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
  const query = params.query?.trim().toLowerCase();
  const symbols: LspSymbol[] = [];

  for (const property of collectJsonPropertyNodes(doc.root)) {
    if (symbols.length >= maxResults) break;
    const key = getJsonPropertyName(property);
    const keyNode = property.children?.[0];
    if (!key || !keyNode) continue;
    const valueNode = property.children?.[1];
    const info = getLineInfo(doc.text, keyNode.offset);
    const containerPath = valueNode ? formatJsonPath(getNodePath(valueNode).slice(0, -1)) : undefined;
    const symbol: LspSymbol = {
      name: key,
      kind: inferJsonSymbolKind(property),
      path: doc.filePath,
      line: info.line,
      character: info.character,
      preview: info.preview,
      containerName: containerPath,
    };
    if (query) {
      const haystack = `${symbol.name} ${symbol.kind} ${symbol.containerName ?? ""} ${symbol.preview}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    symbols.push(symbol);
  }

  const text = symbols.length > 0
    ? symbols.map((symbol, index) => `${index + 1}. ${symbol.path}:${symbol.line}:${symbol.character} [${symbol.kind}] ${symbol.name}${symbol.containerName ? ` (${symbol.containerName})` : ""}\n   ${symbol.preview}`).join("\n")
    : "No symbols found.";
  return { text, symbols };
}

function getJsonDiagnostics(cwd: string, params: { path?: string; maxResults?: number }): { text: string; diagnostics: LspDiagnostic[]; projectPath?: string } {
  const doc = createJsonDocumentContext(cwd, params.path);
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
  const diagnostics = doc.errors.slice(0, maxResults).map((error) => {
    const info = getLineInfo(doc.text, error.offset);
    return {
      path: doc.filePath,
      line: info.line,
      character: info.character,
      code: error.error,
      category: "error",
      message: printParseErrorCode(error.error),
    } satisfies LspDiagnostic;
  });

  const text = diagnostics.length > 0
    ? diagnostics.map((diagnostic, index) => `${index + 1}. ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} [${diagnostic.category} JSON${diagnostic.code}]\n   ${diagnostic.message}`).join("\n")
    : "No diagnostics found.";
  return { text, diagnostics };
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  let next = text;
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of ordered) {
    next = `${next.slice(0, edit.start)}${edit.replacement}${next.slice(edit.end)}`;
  }
  return next;
}

function buildJsonRenamePlan(doc: JsonDocumentContext, params: { line: number; character: number; newName: string }): TextEdit[] {
  const selection = getJsonSelection(doc, params);
  let targetProperty = selection.property;
  let targetValueNode = selection.valueNode;

  if (isJsonRefProperty(selection.property) && selection.valueNode?.type === "string" && typeof selection.valueNode.value === "string") {
    const target = resolveJsonRefNode(doc, selection.valueNode.value);
    targetProperty = target?.parent?.type === "property" ? target.parent : target?.type === "property" ? target : undefined;
    targetValueNode = targetProperty?.children?.[1];
  }

  const propertyName = getJsonPropertyName(targetProperty);
  const keyNode = targetProperty?.children?.[0];
  if (!targetProperty || !propertyName || !keyNode) {
    throw new Error("Place the cursor on a JSON property key or a $ref value to rename it.");
  }

  const edits: TextEdit[] = [];
  const matchingProperties = collectJsonPropertyNodes(doc.root).filter((property) => getJsonPropertyName(property) === propertyName);
  for (const property of matchingProperties) {
    const currentKey = property.children?.[0];
    if (!currentKey) continue;
    edits.push({ start: currentKey.offset, end: currentKey.offset + currentKey.length, replacement: JSON.stringify(params.newName) });
  }

  const oldPointer = targetValueNode ? toJsonPointer(getNodePath(targetValueNode)) : undefined;
  if (oldPointer) {
    const oldPath = parseJsonPointer(oldPointer);
    if (oldPath && oldPath.length > 0) {
      const newPointer = toJsonPointer([...oldPath.slice(0, -1), params.newName]);
      for (const ref of collectJsonRefNodes(doc.root)) {
        if (ref.ref === oldPointer) {
          edits.push({ start: ref.valueNode.offset, end: ref.valueNode.offset + ref.valueNode.length, replacement: JSON.stringify(newPointer) });
        }
      }
    }
  }

  const unique = new Map<string, TextEdit>();
  for (const edit of edits) unique.set(`${edit.start}:${edit.end}:${edit.replacement}`, edit);
  return [...unique.values()];
}

function renameJsonSymbol(cwd: string, params: { path: string; line: number; character: number; newName: string; apply?: boolean }): { text: string; files: LspRenameFileEdit[] } {
  const doc = createJsonDocumentContext(cwd, params.path);
  const edits = buildJsonRenamePlan(doc, params);
  if (edits.length === 0) return { text: "No rename locations found.", files: [] };
  if (params.apply) {
    fs.writeFileSync(doc.filePath, applyTextEdits(doc.text, edits));
  }
  const action = params.apply ? "Applied" : "Prepared";
  return {
    text: `${action} JSON rename to '${params.newName}' across 1 file.\n\n- ${doc.filePath} (${edits.length} edit${edits.length === 1 ? "" : "s"})`,
    files: [{ path: doc.filePath, edits: edits.length }],
  };
}

function detectBackend(filePath: string): "ts" | "json" | "python" | "native" {
  if (isTsLikeFile(filePath)) return "ts";
  if (isJsonLikeFile(filePath)) return "json";
  if (isPythonFile(filePath)) return "python";
  if (isGoFile(filePath) || isRustFile(filePath)) return "native";
  throw new Error(`Unsupported file for Pantheon LSP tooling: ${filePath}`);
}

function resolveRequestedBackend(cwd: string, requestedPath?: string): "ts" | "json" | "python" | "native" {
  if (!requestedPath) return "ts";
  return detectBackend(resolveFilePath(cwd, requestedPath));
}

export function hoverSymbol(cwd: string, params: { path: string; line: number; character: number }): { text: string; display?: string; documentation?: string } {
  const backend = detectBackend(resolveFilePath(cwd, params.path));
  if (backend === "json") {
    return buildJsonHover(createJsonDocumentContext(cwd, params.path), getJsonSelection(createJsonDocumentContext(cwd, params.path), params));
  }
  if (backend === "python") return hoverPythonSymbol(cwd, params);
  if (backend === "native") return hoverNativeSymbol(cwd, params);
  return hoverTypeScriptSymbol(cwd, params);
}

export function gotoDefinition(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const backend = detectBackend(resolveFilePath(cwd, params.path));
  if (backend === "json") return gotoJsonDefinition(cwd, params);
  if (backend === "python") return gotoPythonDefinition(cwd, params);
  if (backend === "native") return gotoNativeDefinition(cwd, params);
  return gotoTypeScriptDefinition(cwd, params);
}

export function findReferences(cwd: string, params: { path: string; line: number; character: number; includeDeclaration?: boolean }): { text: string; locations: LspLocation[] } {
  const backend = detectBackend(resolveFilePath(cwd, params.path));
  if (backend === "json") return findJsonReferences(cwd, params);
  if (backend === "python") return findPythonReferences(cwd, params);
  if (backend === "native") return findNativeReferences(cwd, params);
  return findTypeScriptReferences(cwd, params);
}

export function findImplementations(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const backend = detectBackend(resolveFilePath(cwd, params.path));
  if (backend === "json") return findJsonImplementations(cwd, params);
  if (backend === "python") return findPythonImplementations(cwd, params);
  if (backend === "native") return findNativeImplementations(cwd, params);
  return findTypeScriptImplementations(cwd, params);
}

export function getTypeDefinitions(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
  const backend = detectBackend(resolveFilePath(cwd, params.path));
  if (backend === "json") return getJsonTypeDefinitions(cwd, params);
  if (backend === "python") return getPythonTypeDefinitions(cwd, params);
  if (backend === "native") return getNativeTypeDefinitions(cwd, params);
  return getTypeScriptTypeDefinitions(cwd, params);
}

export function listSymbols(cwd: string, params: { path?: string; query?: string; maxResults?: number }): { text: string; symbols: LspSymbol[]; projectPath?: string } {
  const backend = resolveRequestedBackend(cwd, params.path);
  if (backend === "json") return listJsonSymbols(cwd, params);
  if (backend === "python") return listPythonSymbols(cwd, params);
  if (backend === "native") return listNativeSymbols(cwd, params);
  return listTypeScriptSymbols(cwd, params);
}

export function getDiagnostics(cwd: string, params: { path?: string; maxResults?: number }): { text: string; diagnostics: LspDiagnostic[]; projectPath?: string } {
  const backend = resolveRequestedBackend(cwd, params.path);
  if (backend === "json") return getJsonDiagnostics(cwd, params);
  if (backend === "python") return getPythonDiagnostics(cwd, params);
  if (backend === "native") return getNativeDiagnostics(cwd, params);
  return getTypeScriptDiagnostics(cwd, params);
}

export function renameSymbol(cwd: string, params: { path: string; line: number; character: number; newName: string; apply?: boolean }): { text: string; files: LspRenameFileEdit[] } {
  const backend = detectBackend(resolveFilePath(cwd, params.path));
  if (backend === "json") return renameJsonSymbol(cwd, params);
  if (backend === "python") return renamePythonSymbol(cwd, params);
  if (backend === "native") return renameNativeSymbol(cwd, params);
  return renameTypeScriptSymbol(cwd, params);
}
