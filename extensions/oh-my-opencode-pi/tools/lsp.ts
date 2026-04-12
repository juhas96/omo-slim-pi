import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import * as ts from "typescript";

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
  path: Type.Optional(Type.String({ description: "Optional file path. Omit to inspect the nearest TS/JS project." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum diagnostics to return.", default: 100 })),
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

interface ProjectContext {
  service: ts.LanguageService;
  filePath: string;
  fileNames: string[];
  projectDir: string;
  configPath?: string;
  dispose(): void;
}

function isSupportedFile(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(filePath);
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
      filePath = parsed.fileNames.find((name) => isSupportedFile(name) && !name.includes(`${path.sep}node_modules${path.sep}`)) ?? parsed.fileNames[0] ?? absolutePath;
    }
  }

  if (!fileNames.includes(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    fileNames.push(filePath);
  }

  if (!isSupportedFile(filePath)) {
    throw new Error(`Unsupported file for Pantheon LSP tooling: ${filePath}`);
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
  const info = getLineInfo(text, textSpan.start);
  return {
    path: filePath,
    line: info.line,
    character: info.character,
    preview: info.preview,
    kind,
    name,
  };
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

export function gotoDefinition(cwd: string, params: { path: string; line: number; character: number }): { text: string; locations: LspLocation[] } {
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

export function findReferences(cwd: string, params: { path: string; line: number; character: number; includeDeclaration?: boolean }): { text: string; locations: LspLocation[] } {
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

export function getDiagnostics(cwd: string, params: { path?: string; maxResults?: number }): { text: string; diagnostics: LspDiagnostic[]; projectPath?: string } {
  const context = createProjectContext(cwd, params.path);
  try {
    const maxResults = Math.max(1, Math.floor(params.maxResults ?? 100));
    const candidateFiles = params.path
      ? [context.filePath]
      : context.fileNames.filter((filePath) => isSupportedFile(filePath) && !filePath.includes(`${path.sep}node_modules${path.sep}`));

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

export function renameSymbol(cwd: string, params: { path: string; line: number; character: number; newName: string; apply?: boolean }): { text: string; files: LspRenameFileEdit[] } {
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
