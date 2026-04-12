import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";

const require = createRequire(import.meta.url);

export const AstGrepSearchParams = Type.Object({
  pattern: Type.String({ description: "AST-grep search pattern." }),
  path: Type.Optional(Type.String({ description: "Target file or directory. Defaults to the current working directory." })),
  lang: Type.Optional(Type.String({ description: "Language identifier such as ts, tsx, js, jsx, json, rust, go, python, or html." })),
  selector: Type.Optional(Type.String({ description: "Optional AST selector/kind." })),
  strictness: Type.Optional(Type.String({ description: "Pattern strictness: cst, smart, ast, relaxed, signature, or template." })),
  globs: Type.Optional(Type.Array(Type.String({ description: "Optional include/exclude globs." }))),
  maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return.", default: 50 })),
});

export const AstGrepReplaceParams = Type.Object({
  pattern: Type.String({ description: "AST-grep search pattern." }),
  rewrite: Type.String({ description: "Rewrite template." }),
  path: Type.Optional(Type.String({ description: "Target file or directory. Defaults to the current working directory." })),
  lang: Type.Optional(Type.String({ description: "Language identifier such as ts, tsx, js, jsx, json, rust, go, python, or html." })),
  selector: Type.Optional(Type.String({ description: "Optional AST selector/kind." })),
  strictness: Type.Optional(Type.String({ description: "Pattern strictness: cst, smart, ast, relaxed, signature, or template." })),
  globs: Type.Optional(Type.Array(Type.String({ description: "Optional include/exclude globs." }))),
  maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return.", default: 50 })),
  apply: Type.Optional(Type.Boolean({ description: "Apply the rewrite to disk. Default false previews only.", default: false })),
});

export interface AstGrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  context: string;
  language?: string;
}

function getAstGrepExecutable(): string {
  const packageJsonPath = require.resolve("@ast-grep/cli/package.json");
  const packageDir = path.dirname(packageJsonPath);
  return path.join(packageDir, process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
}

function resolveTargetPath(cwd: string, value?: string): string {
  return value ? (path.isAbsolute(value) ? value : path.resolve(cwd, value)) : cwd;
}

function inferLanguageFromPath(targetPath: string): string | undefined {
  const ext = path.extname(targetPath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".py":
      return "python";
    case ".html":
      return "html";
    case ".css":
      return "css";
    default:
      return undefined;
  }
}

function buildCommonArgs(
  cwd: string,
  params: {
    pattern: string;
    path?: string;
    lang?: string;
    selector?: string;
    strictness?: string;
    globs?: string[];
  },
): { args: string[]; targetPath: string; language: string } {
  const targetPath = resolveTargetPath(cwd, params.path);
  const language = params.lang?.trim() || inferLanguageFromPath(targetPath);
  if (!language) {
    throw new Error("AST-grep requires `lang` when the target path does not imply a supported language.");
  }

  const args = ["run", "--pattern", params.pattern, "--lang", language, "--json=stream"];
  if (params.selector?.trim()) args.push("--selector", params.selector.trim());
  if (params.strictness?.trim()) args.push("--strictness", params.strictness.trim());
  for (const glob of params.globs ?? []) {
    if (glob.trim()) args.push("--globs", glob.trim());
  }
  args.push(targetPath);
  return { args, targetPath, language };
}

interface RawAstGrepMatch {
  file: string;
  text: string;
  lines: string;
  language?: string;
  replacement?: string;
  range: { start: { line: number; column: number } };
  replacementOffsets?: { start: number; end: number };
}

function parseRawMatches(output: string): RawAstGrepMatch[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawAstGrepMatch);
}

function parseMatches(output: string, maxResults: number): AstGrepMatch[] {
  return parseRawMatches(output)
    .slice(0, maxResults)
    .map((item) => ({
      path: item.file,
      line: item.range.start.line + 1,
      column: item.range.start.column + 1,
      text: item.text,
      context: item.lines,
      language: item.language,
    }));
}

function formatMatches(matches: AstGrepMatch[]): string {
  if (matches.length === 0) return "No structural matches found.";
  return matches.map((match, index) => `${index + 1}. ${match.path}:${match.line}:${match.column}${match.language ? ` [${match.language}]` : ""}\n   ${match.context.replace(/\s+/g, " ").trim()}`).join("\n");
}

export function astGrepSearch(
  cwd: string,
  params: {
    pattern: string;
    path?: string;
    lang?: string;
    selector?: string;
    strictness?: string;
    globs?: string[];
    maxResults?: number;
  },
): { text: string; matches: AstGrepMatch[]; language: string; targetPath: string } {
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 50));
  const { args, targetPath, language } = buildCommonArgs(cwd, params);
  const output = execFileSync(getAstGrepExecutable(), args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const matches = parseMatches(output, maxResults);
  return {
    text: formatMatches(matches),
    matches,
    language,
    targetPath,
  };
}

export function astGrepReplace(
  cwd: string,
  params: {
    pattern: string;
    rewrite: string;
    path?: string;
    lang?: string;
    selector?: string;
    strictness?: string;
    globs?: string[];
    maxResults?: number;
    apply?: boolean;
  },
): { text: string; matches: AstGrepMatch[]; language: string; targetPath: string; applied: boolean } {
  const maxResults = Math.max(1, Math.floor(params.maxResults ?? 50));
  const { args, targetPath, language } = buildCommonArgs(cwd, params);
  args.push("--rewrite", params.rewrite);
  const output = execFileSync(getAstGrepExecutable(), args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rawMatches = parseRawMatches(output);
  const matches = rawMatches.slice(0, maxResults).map((item) => ({
    path: item.file,
    line: item.range.start.line + 1,
    column: item.range.start.column + 1,
    text: item.text,
    context: item.lines,
    language: item.language,
  }));

  if (params.apply) {
    const grouped = new Map<string, RawAstGrepMatch[]>();
    for (const match of rawMatches) {
      const existing = grouped.get(match.file) ?? [];
      existing.push(match);
      grouped.set(match.file, existing);
    }
    for (const [filePath, entries] of grouped.entries()) {
      let text = fs.readFileSync(filePath, "utf8");
      const ordered = entries
        .filter((entry) => typeof entry.replacement === "string" && entry.replacementOffsets)
        .sort((a, b) => (b.replacementOffsets!.start - a.replacementOffsets!.start));
      for (const entry of ordered) {
        text = `${text.slice(0, entry.replacementOffsets!.start)}${entry.replacement ?? ""}${text.slice(entry.replacementOffsets!.end)}`;
      }
      fs.writeFileSync(filePath, text);
    }
  }

  const action = params.apply ? "Applied" : "Prepared";
  const body = matches.length > 0
    ? `${action} structural rewrite for ${matches.length} match${matches.length === 1 ? "" : "es"}.\n\n${formatMatches(matches)}`
    : "No structural matches found.";
  return {
    text: body,
    matches,
    language,
    targetPath,
    applied: Boolean(params.apply),
  };
}
