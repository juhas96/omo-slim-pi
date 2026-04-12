export interface RescueEdit {
  oldText?: string;
  newText?: string;
}

export interface RescueEditSequenceResult {
  edits: RescueEdit[];
  rescuedAny: boolean;
}

function normalizeLine(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+$/gm, "").normalize("NFC");
}

function meaningfulLines(text: string): string[] {
  return normalizeLine(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) return count;
    count++;
    index = found + Math.max(1, needle.length);
  }
}

function scoreTextSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const aa = normalizeLine(a);
  const bb = normalizeLine(b);
  if (aa === bb) return 1;

  const aLines = aa.split("\n");
  const bLines = bb.split("\n");
  const maxLines = Math.max(aLines.length, bLines.length);
  let exactLineMatches = 0;
  for (let i = 0; i < Math.min(aLines.length, bLines.length); i++) {
    if (aLines[i] === bLines[i]) exactLineMatches++;
  }

  const aSet = new Set(meaningfulLines(aa));
  const bSet = new Set(meaningfulLines(bb));
  const intersection = [...aSet].filter((line) => bSet.has(line)).length;
  const union = new Set([...aSet, ...bSet]).size || 1;
  const sharedLineRatio = intersection / union;
  const lengthRatio = Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length);
  const lineRatio = exactLineMatches / maxLines;
  const prefixRatio = aa.slice(0, Math.min(80, aa.length)) === bb.slice(0, Math.min(80, bb.length)) ? 1 : 0;
  const suffixRatio = aa.slice(-Math.min(80, aa.length)) === bb.slice(-Math.min(80, bb.length)) ? 1 : 0;
  return (lineRatio * 0.35) + (sharedLineRatio * 0.25) + (lengthRatio * 0.2) + (prefixRatio * 0.1) + (suffixRatio * 0.1);
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index < 0) return haystack;
  return `${haystack.slice(0, index)}${replacement}${haystack.slice(index + needle.length)}`;
}

function selectBestUniqueCandidate(candidates: Map<string, number>): string | undefined {
  const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return undefined;
  if (ranked.length === 1) return ranked[0][0];
  if (ranked[0][1] - ranked[1][1] >= 0.04) return ranked[0][0];
  return undefined;
}

function findAnchorBasedMatch(content: string, needle: string): string | undefined {
  const normalizedNeedleLines = meaningfulLines(needle);
  if (normalizedNeedleLines.length < 2) return undefined;
  const firstAnchor = normalizedNeedleLines[0];
  const lastAnchor = normalizedNeedleLines[normalizedNeedleLines.length - 1];
  if (firstAnchor.length < 6 || lastAnchor.length < 6) return undefined;

  const contentLines = content.split(/\n/);
  const normalizedContentLines = contentLines.map((line) => normalizeLine(line).trim());
  const firstIndexes = normalizedContentLines.map((line, index) => line === firstAnchor ? index : -1).filter((index) => index >= 0);
  const lastIndexes = normalizedContentLines.map((line, index) => line === lastAnchor ? index : -1).filter((index) => index >= 0);
  if (firstIndexes.length === 0 || lastIndexes.length === 0) return undefined;

  const targetLineCount = Math.max(1, needle.split(/\n/).length);
  const candidates = new Map<string, number>();
  for (const start of firstIndexes) {
    for (const end of lastIndexes) {
      if (end < start) continue;
      const lineCount = end - start + 1;
      if (Math.abs(lineCount - targetLineCount) > 3) continue;
      const windowText = contentLines.slice(start, end + 1).join("\n");
      const score = scoreTextSimilarity(needle, windowText) + 0.06;
      if (score >= 0.9) candidates.set(windowText, score);
    }
  }

  return selectBestUniqueCandidate(candidates);
}

function findDistinctiveLineSignatureMatch(content: string, needle: string): string | undefined {
  const needleMeaningful = meaningfulLines(needle).filter((line) => line.length >= 8);
  if (needleMeaningful.length < 2) return undefined;

  const contentLines = content.split(/\n/);
  const targetLineCount = Math.max(1, needle.split(/\n/).length);
  const distinctive = needleMeaningful
    .sort((a, b) => b.length - a.length)
    .filter((line, index, array) => array.indexOf(line) === index)
    .slice(0, 3);

  const candidates = new Map<string, number>();
  for (let lineCount = Math.max(1, targetLineCount - 3); lineCount <= Math.min(contentLines.length, targetLineCount + 3); lineCount++) {
    for (let start = 0; start <= contentLines.length - lineCount; start++) {
      const windowText = contentLines.slice(start, start + lineCount).join("\n");
      const normalizedWindow = normalizeLine(windowText);
      if (!distinctive.every((line) => normalizedWindow.includes(line))) continue;
      const score = scoreTextSimilarity(needle, windowText) + 0.05;
      if (score >= 0.9) candidates.set(windowText, score);
    }
  }

  return selectBestUniqueCandidate(candidates);
}

function findTolerantMatch(content: string, needle: string): string | undefined {
  if (!needle) return undefined;
  if (content.includes(needle)) return needle;

  const normalizedNeedle = normalizeLine(needle);
  const lines = content.split(/\n/);
  const needleLineCount = Math.max(1, needle.split(/\n/).length);

  const exactToleranceMatches = new Map<string, string[]>();
  for (let start = 0; start <= lines.length - needleLineCount; start++) {
    const windowText = lines.slice(start, start + needleLineCount).join("\n");
    const key = normalizeLine(windowText);
    const existing = exactToleranceMatches.get(key) ?? [];
    existing.push(windowText);
    exactToleranceMatches.set(key, existing);
  }

  const normalizedMatches = exactToleranceMatches.get(normalizedNeedle) ?? [];
  if (normalizedMatches.length === 1) return normalizedMatches[0];

  const anchorMatch = findAnchorBasedMatch(content, needle);
  if (anchorMatch) return anchorMatch;

  const signatureMatch = findDistinctiveLineSignatureMatch(content, needle);
  if (signatureMatch) return signatureMatch;

  const candidates = new Map<string, number>();
  const minLines = Math.max(1, needleLineCount - 2);
  const maxLines = Math.min(lines.length, needleLineCount + 2);
  const anchors = meaningfulLines(needle);
  const firstAnchor = anchors[0];
  const lastAnchor = anchors[anchors.length - 1];

  for (let lineCount = minLines; lineCount <= maxLines; lineCount++) {
    for (let start = 0; start <= lines.length - lineCount; start++) {
      const windowText = lines.slice(start, start + lineCount).join("\n");
      const normalizedWindow = normalizeLine(windowText);
      if (normalizedWindow === normalizedNeedle && countOccurrences(content, windowText) === 1) return windowText;

      let score = scoreTextSimilarity(needle, windowText);
      const windowMeaningful = meaningfulLines(windowText);
      if (firstAnchor && windowMeaningful.includes(firstAnchor)) score += 0.03;
      if (lastAnchor && windowMeaningful.includes(lastAnchor)) score += 0.03;
      if (score >= 0.87) candidates.set(windowText, score);
    }
  }

  return selectBestUniqueCandidate(candidates);
}

export function rescueEditSequence(content: string, edits: RescueEdit[]): RescueEditSequenceResult {
  let workingContent = content;
  let rescuedAny = false;
  const rescuedEdits = edits.map((edit) => ({ ...edit }));

  for (const edit of rescuedEdits) {
    if (!edit.oldText) continue;
    const directMatch = workingContent.includes(edit.oldText) ? edit.oldText : undefined;
    const rescued = directMatch ?? findTolerantMatch(workingContent, edit.oldText);
    if (!rescued) continue;
    if (!directMatch) {
      edit.oldText = rescued;
      rescuedAny = true;
    }
    workingContent = replaceFirst(workingContent, rescued, edit.newText ?? "");
  }

  return { edits: rescuedEdits, rescuedAny };
}
