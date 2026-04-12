import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";

export const ApplyPatchParams = Type.Object({
  patch: Type.String({ description: "Unified diff patch to preview or apply." }),
  apply: Type.Optional(Type.Boolean({ description: "Apply the patch to disk. Default false previews only.", default: false })),
});

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

interface ParsedFilePatch {
  oldPath: string;
  newPath: string;
  hunks: ParsedHunk[];
}

export interface PatchApplicationDetail {
  path: string;
  status: "updated" | "created" | "deleted" | "renamed";
  hunks: number;
  added: number;
  removed: number;
  previousPath?: string;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  const withoutMetadata = trimmed.split("\t")[0]?.trim() ?? trimmed;
  if (withoutMetadata === "/dev/null") return withoutMetadata;
  if (withoutMetadata.startsWith("a/") || withoutMetadata.startsWith("b/")) return withoutMetadata.slice(2);
  return withoutMetadata;
}

function normalizeLine(line: string): string {
  return line.normalize("NFC").replace(/\s+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseUnifiedDiff(diff: string): ParsedFilePatch[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | undefined;
  let currentHunk: ParsedHunk | undefined;

  const flushCurrent = () => {
    if (!current) return;
    if (!current.newPath) throw new Error(`Malformed patch: missing +++ header for ${current.oldPath || "(unknown file)"}.`);
    files.push(current);
    current = undefined;
    currentHunk = undefined;
  };

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("similarity index ") || line.startsWith("rename from ") || line.startsWith("rename to ")) {
      continue;
    }
    if (line.startsWith("--- ")) {
      flushCurrent();
      current = { oldPath: normalizePath(line.slice(4)), newPath: "", hunks: [] };
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) throw new Error("Malformed patch: encountered +++ before ---. ");
      current.newPath = normalizePath(line.slice(4));
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (!current) throw new Error("Malformed patch: encountered hunk before file header.");
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (line === "\\ No newline at end of file") continue;
    if (currentHunk) {
      const prefix = line[0];
      if (![" ", "+", "-"].includes(prefix)) {
        throw new Error(`Malformed patch hunk line: ${line}`);
      }
      currentHunk.lines.push(line);
    }
  }

  flushCurrent();
  if (files.length === 0) throw new Error("No file patches found in unified diff.");

  for (const file of files) {
    for (const hunk of file.hunks) {
      const oldActual = hunk.lines.filter((entry) => entry.startsWith(" ") || entry.startsWith("-")).length;
      const newActual = hunk.lines.filter((entry) => entry.startsWith(" ") || entry.startsWith("+")).length;
      if (oldActual !== hunk.oldCount) {
        throw new Error(`Malformed patch hunk for ${file.newPath || file.oldPath}: expected ${hunk.oldCount} old lines, found ${oldActual}.`);
      }
      if (newActual !== hunk.newCount) {
        throw new Error(`Malformed patch hunk for ${file.newPath || file.oldPath}: expected ${hunk.newCount} new lines, found ${newActual}.`);
      }
    }
  }

  return files;
}

function ensureInsideRoot(cwd: string, candidate: string): string {
  const resolved = path.resolve(cwd, candidate);
  const relative = path.relative(cwd, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`Patch path escapes the workspace root: ${candidate}`);
}

function resolveExistingPath(cwd: string, filePatch: ParsedFilePatch): string | undefined {
  if (!filePatch.oldPath || filePatch.oldPath === "/dev/null") return undefined;
  return path.isAbsolute(filePatch.oldPath) ? ensureInsideRoot(cwd, filePatch.oldPath) : ensureInsideRoot(cwd, filePatch.oldPath);
}

function resolveTargetPath(cwd: string, filePatch: ParsedFilePatch): string | undefined {
  if (!filePatch.newPath || filePatch.newPath === "/dev/null") return undefined;
  return path.isAbsolute(filePatch.newPath) ? ensureInsideRoot(cwd, filePatch.newPath) : ensureInsideRoot(cwd, filePatch.newPath);
}

function buildBeforeLines(hunk: ParsedHunk): string[] {
  return hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1));
}

function buildAfterLines(hunk: ParsedHunk): string[] {
  return hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1));
}

function hunkAddedCount(hunk: ParsedHunk): number {
  return hunk.lines.filter((line) => line.startsWith("+")).length;
}

function hunkRemovedCount(hunk: ParsedHunk): number {
  return hunk.lines.filter((line) => line.startsWith("-")).length;
}

function blockSimilarity(lines: string[], needle: string[]): number {
  const lengthPenalty = Math.abs(lines.length - needle.length) * 3;
  const max = Math.max(lines.length, needle.length);
  let matches = 0;
  for (let index = 0; index < max; index++) {
    if ((lines[index] ?? "") === (needle[index] ?? "")) matches += 1;
  }
  return matches * 8 - lengthPenalty;
}

function findCandidateIndices(lines: string[], needle: string[], expectedIndex: number): number[] {
  if (needle.length === 0) return [Math.max(0, Math.min(lines.length, expectedIndex))];
  const normalizedLines = lines.map(normalizeLine);
  const normalizedNeedle = needle.map(normalizeLine);
  const exact: number[] = [];
  for (let index = 0; index <= normalizedLines.length - normalizedNeedle.length; index++) {
    let matches = true;
    for (let offset = 0; offset < normalizedNeedle.length; offset++) {
      if (normalizedLines[index + offset] !== normalizedNeedle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) exact.push(index);
  }
  if (exact.length > 0) {
    return exact.sort((a, b) => Math.abs(a - expectedIndex) - Math.abs(b - expectedIndex));
  }

  const candidates: Array<{ index: number; score: number }> = [];
  const minLength = Math.max(0, normalizedNeedle.length - 2);
  const maxLength = Math.min(normalizedLines.length, normalizedNeedle.length + 2);
  for (let length = minLength; length <= maxLength; length++) {
    for (let index = 0; index <= normalizedLines.length - length; index++) {
      const window = normalizedLines.slice(index, index + length);
      let score = blockSimilarity(window, normalizedNeedle);
      if (window[0] === normalizedNeedle[0]) score += 5;
      if (window[window.length - 1] === normalizedNeedle[normalizedNeedle.length - 1]) score += 5;
      score -= Math.abs(index - expectedIndex);
      if (score > 0) candidates.push({ index, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.index - expectedIndex) - Math.abs(b.index - expectedIndex));
  if (candidates.length === 0) return [];
  if (candidates.length > 1 && candidates[0].score === candidates[1].score && candidates[0].index !== candidates[1].index) {
    throw new Error(`Ambiguous patch hunk match near old line ${expectedIndex + 1}.`);
  }
  return [candidates[0].index];
}

function applyHunksToLines(lines: string[], hunks: ParsedHunk[]): string[] {
  let current = [...lines];
  for (const hunk of hunks) {
    const beforeLines = buildBeforeLines(hunk);
    const afterLines = buildAfterLines(hunk);
    const expectedIndex = Math.max(0, hunk.oldStart - 1);
    const candidates = findCandidateIndices(current, beforeLines, expectedIndex);
    if (candidates.length === 0) {
      throw new Error(`Unable to match patch hunk near old line ${hunk.oldStart}.`);
    }
    const targetIndex = candidates[0];
    current = [
      ...current.slice(0, targetIndex),
      ...afterLines,
      ...current.slice(targetIndex + beforeLines.length),
    ];
  }
  return current;
}

function detectEol(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function hasFinalNewline(text: string): boolean {
  return text.endsWith("\n");
}

function joinLines(lines: string[], eol: string, finalNewline: boolean): string {
  const body = lines.join(eol);
  return finalNewline ? `${body}${eol}` : body;
}

function readFileLines(filePath: string): { text: string; lines: string[]; eol: "\n" | "\r\n"; finalNewline: boolean } {
  const text = fs.readFileSync(filePath, "utf8");
  const normalized = text.replace(/\r\n/g, "\n");
  const finalNewline = hasFinalNewline(text);
  const lines = normalized.split("\n");
  if (finalNewline && lines[lines.length - 1] === "") lines.pop();
  return { text, lines, eol: detectEol(text), finalNewline };
}

function describeAction(detail: PatchApplicationDetail): string {
  const renameInfo = detail.previousPath && detail.previousPath !== detail.path ? ` from ${detail.previousPath}` : "";
  return `- ${detail.path} [${detail.status}]${renameInfo} (${detail.hunks} hunk${detail.hunks === 1 ? "" : "s"}, +${detail.added}/-${detail.removed})`;
}

export function applyUnifiedPatch(cwd: string, params: { patch: string; apply?: boolean }): { text: string; files: PatchApplicationDetail[]; applied: boolean } {
  const filePatches = parseUnifiedDiff(params.patch);
  const details: PatchApplicationDetail[] = [];

  for (const filePatch of filePatches) {
    const existingPath = resolveExistingPath(cwd, filePatch);
    const targetPath = resolveTargetPath(cwd, filePatch);
    const added = filePatch.hunks.reduce((sum, hunk) => sum + hunkAddedCount(hunk), 0);
    const removed = filePatch.hunks.reduce((sum, hunk) => sum + hunkRemovedCount(hunk), 0);

    if (!existingPath && !targetPath) {
      throw new Error("Patch does not reference a writable file path.");
    }

    if (filePatch.oldPath === "/dev/null") {
      if (!targetPath) throw new Error("Create-file patch is missing a target path.");
      const nextLines = applyHunksToLines([], filePatch.hunks);
      if (params.apply) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, joinLines(nextLines, "\n", true));
      }
      details.push({ path: targetPath, status: "created", hunks: filePatch.hunks.length, added, removed });
      continue;
    }

    if (!existingPath || !fs.existsSync(existingPath)) {
      throw new Error(`Patch references missing file: ${filePatch.oldPath}`);
    }

    const original = readFileLines(existingPath);
    const nextLines = applyHunksToLines(original.lines, filePatch.hunks);

    if (filePatch.newPath === "/dev/null") {
      if (params.apply) {
        fs.unlinkSync(existingPath);
      }
      details.push({ path: existingPath, status: "deleted", hunks: filePatch.hunks.length, added, removed, previousPath: existingPath });
      continue;
    }

    if (!targetPath) throw new Error(`Patch is missing a target path for ${filePatch.oldPath}`);
    const renamed = existingPath !== targetPath;
    if (params.apply) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, joinLines(nextLines, original.eol, original.finalNewline));
      if (renamed && fs.existsSync(existingPath)) fs.unlinkSync(existingPath);
    }
    details.push({
      path: targetPath,
      status: renamed ? "renamed" : "updated",
      hunks: filePatch.hunks.length,
      added,
      removed,
      previousPath: renamed ? existingPath : undefined,
    });
  }

  const action = params.apply ? "Applied" : "Prepared";
  return {
    text: `${action} unified patch across ${details.length} file${details.length === 1 ? "" : "s"}.\n\n${details.map(describeAction).join("\n")}`,
    files: details,
    applied: Boolean(params.apply),
  };
}
