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
  status: "updated" | "created";
  hunks: number;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return trimmed;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function normalizeLine(line: string): string {
  return line.normalize("NFC").replace(/\s+$/g, "");
}

function parseUnifiedDiff(diff: string): ParsedFilePatch[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | undefined;
  let currentHunk: ParsedHunk | undefined;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (current && !files.includes(current)) files.push(current);
      current = { oldPath: normalizePath(line.slice(4)), newPath: "", hunks: [] };
      currentHunk = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!current) throw new Error("Malformed patch: encountered +++ before ---.");
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
    if (currentHunk && /^[ +\-]/.test(line)) {
      currentHunk.lines.push(line);
    }
  }

  if (current && !files.includes(current)) files.push(current);
  return files.filter((file) => file.newPath || file.oldPath);
}

function getTargetPath(cwd: string, filePatch: ParsedFilePatch): string {
  const candidate = filePatch.newPath !== "/dev/null" ? filePatch.newPath : filePatch.oldPath;
  if (!candidate || candidate === "/dev/null") throw new Error("Patch does not reference a writable file path.");
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

function buildBeforeLines(hunk: ParsedHunk): string[] {
  return hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1));
}

function buildAfterLines(hunk: ParsedHunk): string[] {
  return hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1));
}

function findCandidateIndices(lines: string[], needle: string[], expectedIndex: number): number[] {
  if (needle.length === 0) return [Math.max(0, Math.min(lines.length, expectedIndex))];
  const normalizedLines = lines.map(normalizeLine);
  const normalizedNeedle = needle.map(normalizeLine);
  const candidates: number[] = [];
  for (let i = 0; i <= normalizedLines.length - normalizedNeedle.length; i++) {
    let matches = true;
    for (let j = 0; j < normalizedNeedle.length; j++) {
      if (normalizedLines[i + j] !== normalizedNeedle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) candidates.push(i);
  }
  return candidates.sort((a, b) => Math.abs(a - expectedIndex) - Math.abs(b - expectedIndex));
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

export function applyUnifiedPatch(cwd: string, params: { patch: string; apply?: boolean }): { text: string; files: PatchApplicationDetail[]; applied: boolean } {
  const files = parseUnifiedDiff(params.patch);
  if (files.length === 0) throw new Error("No file patches found in unified diff.");

  const details: PatchApplicationDetail[] = [];
  for (const filePatch of files) {
    const targetPath = getTargetPath(cwd, filePatch);
    const existed = fs.existsSync(targetPath);
    const originalLines = existed ? fs.readFileSync(targetPath, "utf8").replace(/\r\n/g, "\n").split("\n") : [];
    const nextLines = filePatch.oldPath === "/dev/null"
      ? buildAfterLines(filePatch.hunks[0] ?? { oldStart: 0, oldCount: 0, newStart: 1, newCount: 0, lines: [] })
      : applyHunksToLines(originalLines, filePatch.hunks);

    if (params.apply) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, nextLines.join("\n"));
    }

    details.push({
      path: targetPath,
      status: existed ? "updated" : "created",
      hunks: filePatch.hunks.length,
    });
  }

  const action = params.apply ? "Applied" : "Prepared";
  return {
    text: `${action} unified patch across ${details.length} file${details.length === 1 ? "" : "s"}.\n\n${details.map((detail) => `- ${detail.path} [${detail.status}] (${detail.hunks} hunk${detail.hunks === 1 ? "" : "s"})`).join("\n")}`,
    files: details,
    applied: Boolean(params.apply),
  };
}
