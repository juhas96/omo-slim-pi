import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { applyEdits, format as formatJson } from "jsonc-parser";
import * as ts from "typescript";
import { formatNativeDocument } from "./go-rust-lsp.js";

export const FormatDocumentParams = Type.Object({
  path: Type.String({ description: "Project-relative or absolute file path to format." }),
  apply: Type.Optional(Type.Boolean({ description: "Apply the formatter edits to disk. Default false previews only.", default: false })),
});

export const OrganizeImportsParams = Type.Object({
  path: Type.String({ description: "Project-relative or absolute TS/JS file path." }),
  apply: Type.Optional(Type.Boolean({ description: "Apply organize-import edits to disk. Default false previews only.", default: false })),
});

export interface FormattingResult {
  path: string;
  changed: boolean;
  text: string;
}

function resolveFilePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function applyTextChanges(sourceText: string, changes: readonly ts.TextChange[]): string {
  let next = sourceText;
  const ordered = [...changes].sort((a, b) => b.span.start - a.span.start);
  for (const change of ordered) {
    next = `${next.slice(0, change.span.start)}${change.newText}${next.slice(change.span.start + change.span.length)}`;
  }
  return next;
}

function createTsLanguageService(filePath: string): ts.LanguageService {
  const dir = path.dirname(filePath);
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(dir, ts.sys.fileExists, "jsconfig.json");
  let fileNames = [filePath];
  let currentDir = dir;
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };

  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
      if (parsed.fileNames.length > 0) fileNames = [...new Set([...parsed.fileNames, filePath])];
      options = { ...options, ...parsed.options };
      currentDir = path.dirname(configPath);
    }
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (name) => {
      try {
        const stat = fs.statSync(name);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return "0";
      }
    },
    getScriptSnapshot: (name) => fs.existsSync(name) ? ts.ScriptSnapshot.fromString(fs.readFileSync(name, "utf8")) : undefined,
    getCurrentDirectory: () => currentDir,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

export function formatDocument(cwd: string, params: { path: string; apply?: boolean }): FormattingResult {
  const filePath = resolveFilePath(cwd, params.path);
  const sourceText = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  let nextText = sourceText;
  if ([".json", ".jsonc"].includes(ext)) {
    const edits = formatJson(sourceText, undefined, {
      insertSpaces: true,
      tabSize: 2,
      eol: sourceText.includes("\r\n") ? "\r\n" : "\n",
    });
    nextText = applyEdits(sourceText, edits);
  } else if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
    const service = createTsLanguageService(filePath);
    try {
      const edits = service.getFormattingEditsForDocument(filePath, {
        indentSize: 2,
        tabSize: 2,
        convertTabsToSpaces: true,
        newLineCharacter: sourceText.includes("\r\n") ? "\r\n" : "\n",
        semicolons: ts.SemicolonPreference.Insert,
      });
      nextText = applyTextChanges(sourceText, edits);
    } finally {
      service.dispose();
    }
  } else if ([".go", ".rs"].includes(ext)) {
    const result = formatNativeDocument(cwd, params);
    return { path: result.path, changed: result.changed, text: result.text };
  } else {
    throw new Error(`Formatting is not yet supported for ${ext || "this file type"}.`);
  }

  if (params.apply) fs.writeFileSync(filePath, nextText);
  const changed = nextText !== sourceText;
  return {
    path: filePath,
    changed,
    text: changed
      ? `${params.apply ? "Applied" : "Prepared"} formatting edits for ${filePath}.`
      : `No formatting changes needed for ${filePath}.`,
  };
}

export function organizeImports(cwd: string, params: { path: string; apply?: boolean }): FormattingResult {
  const filePath = resolveFilePath(cwd, params.path);
  const sourceText = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
    throw new Error("Organize imports is currently supported for TS/JS files only.");
  }

  const service = createTsLanguageService(filePath);
  try {
    const changes = service.organizeImports({ type: "file", fileName: filePath }, {}, {});
    const textChanges = changes.flatMap((change) => change.textChanges);
    const nextText = applyTextChanges(sourceText, textChanges);
    if (params.apply) fs.writeFileSync(filePath, nextText);
    const changed = nextText !== sourceText;
    return {
      path: filePath,
      changed,
      text: changed
        ? `${params.apply ? "Applied" : "Prepared"} organize-imports edits for ${filePath}.`
        : `No import organization changes needed for ${filePath}.`,
    };
  } finally {
    service.dispose();
  }
}
