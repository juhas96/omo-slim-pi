import type { PantheonConfig } from "./config.js";

export interface AdapterInvocationLike {
  adapter?: string;
  query?: string;
  package?: string;
  version?: string;
  repo?: string;
  site?: string;
  topic?: string;
  url?: string;
  path?: string;
  limit?: number;
  maxChars?: number;
}

export interface AdapterSelectionExplanation {
  id: string;
  score: number;
  reasons: string[];
}

function resolveGithubToken(config: PantheonConfig): string | undefined {
  return config.research?.githubToken?.trim() || process.env.PANTHEON_GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;
}

export function adapterSelectionQuery(params: AdapterInvocationLike): string {
  return [params.query, params.topic, params.package, params.repo, params.site].filter((value): value is string => Boolean(value?.trim())).join(" ").toLowerCase();
}

function buildAdapterSelectionReasons(adapterId: string, params: AdapterInvocationLike, config?: PantheonConfig): string[] {
  const query = adapterSelectionQuery(params);
  const reasons: string[] = [];
  const hasGithubToken = Boolean(config && resolveGithubToken(config));

  if (params.url && adapterId === "docs-context7") reasons.push("explicit docs URL");
  if (params.package) {
    if (adapterId === "npm-registry") reasons.push("package metadata/README lookup");
    if (adapterId === "docs-context7") reasons.push("package docs lookup");
  }
  if (params.site && adapterId === "docs-context7") reasons.push("docs site constraint");
  if (params.repo) {
    if (adapterId === "github-code-search") reasons.push(`repo-aware code search${hasGithubToken ? " with GitHub token boost" : ""}`);
    if (adapterId === "github-releases" && /(release|changelog|version)/i.test(query)) reasons.push(`repo release history${hasGithubToken ? " with GitHub token boost" : ""}`);
    if (adapterId === "grep-app") reasons.push("public code search fallback");
    if (adapterId === "web-search") reasons.push("generic repo web fallback");
  }
  if (/\b(readme|docs|guide|setup|installation|usage|api|sdk)\b/i.test(query)) {
    if (adapterId === "local-docs") reasons.push("repo-local docs keywords");
    if (adapterId === "docs-context7") reasons.push("docs-focused query");
    if (adapterId === "web-search") reasons.push("generic docs fallback");
  }
  if (/\b(snippet|implementation|example|symbol|pattern|code|source)\b/i.test(query)) {
    if (adapterId === "github-code-search") reasons.push("implementation/code query");
    if (adapterId === "grep-app") reasons.push("public example/code query");
    if (adapterId === "web-search") reasons.push("broad code fallback");
  }
  if (/\b(package|dependency|npm|version|release)\b/i.test(query) && adapterId === "npm-registry") reasons.push("package/version query");
  if (/\b(changelog|release notes|breaking change)\b/i.test(query) && adapterId === "github-releases") reasons.push("release-notes query");
  if (!params.repo && !params.package && !params.site && adapterId === "local-docs") reasons.push("local-first default for repo docs");
  if (adapterId === "web-search") reasons.push("last-resort web fallback");
  return reasons;
}

export function scoreAdapterSelection(adapterId: string, params: AdapterInvocationLike, config?: PantheonConfig): number {
  const query = adapterSelectionQuery(params);
  let score = 0;
  const hasGithubToken = Boolean(config && resolveGithubToken(config));

  if (params.url && adapterId === "docs-context7") score += 100;
  if (params.package) {
    if (adapterId === "npm-registry") score += 70;
    if (adapterId === "docs-context7") score += 55;
  }
  if (params.site && adapterId === "docs-context7") score += 50;
  if (params.repo) {
    if (adapterId === "github-code-search") score += 45 + (hasGithubToken ? 12 : 0);
    if (adapterId === "github-releases" && /(release|changelog|version)/i.test(query)) score += 80 + (hasGithubToken ? 8 : 0);
    if (adapterId === "grep-app") score += 18;
    if (adapterId === "web-search") score += 10;
  }
  if (/\b(readme|docs|guide|setup|installation|usage|api|sdk)\b/i.test(query)) {
    if (adapterId === "local-docs") score += 60;
    if (adapterId === "docs-context7") score += 45;
    if (adapterId === "web-search") score += 15;
  }
  if (/\b(snippet|implementation|example|symbol|pattern|code|source)\b/i.test(query)) {
    if (adapterId === "github-code-search") score += 55;
    if (adapterId === "grep-app") score += 45;
    if (adapterId === "web-search") score += 10;
  }
  if (/\b(package|dependency|npm|version|release)\b/i.test(query) && adapterId === "npm-registry") score += 40;
  if (/\b(changelog|release notes|breaking change)\b/i.test(query) && adapterId === "github-releases") score += 40;
  if (!params.repo && !params.package && !params.site && adapterId === "local-docs") score += 20;
  if (adapterId === "web-search") score += 5;
  return score;
}

export function rankAdapterSelections(config: PantheonConfig, params: AdapterInvocationLike): AdapterSelectionExplanation[] {
  const candidates = ["local-docs", "docs-context7", "npm-registry", "github-releases", "github-code-search", "grep-app", "web-search"];
  return candidates
    .map((id) => ({ id, score: scoreAdapterSelection(id, params, config), reasons: buildAdapterSelectionReasons(id, params, config) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function selectAdapterIds(config: PantheonConfig, requested: string | undefined, params: AdapterInvocationLike): string[] {
  const requestedId = requested?.trim();
  if (requestedId && requestedId !== "auto") return [requestedId];

  const ranked = rankAdapterSelections(config, params)
    .slice(0, params.repo ? 4 : 3)
    .map((item) => item.id);

  if (ranked.length > 0) return ranked;
  return config.adapters?.defaultAllow?.length ? [...config.adapters.defaultAllow] : ["local-docs", "docs-context7", "web-search"];
}

export function renderAdapterSelectionReport(config: PantheonConfig, requested: string | undefined, params: AdapterInvocationLike): string {
  const requestedId = requested?.trim();
  if (requestedId && requestedId !== "auto") {
    return `Selection:\n- Using requested adapter: ${requestedId}`;
  }

  const ranked = rankAdapterSelections(config, params);
  const selected = selectAdapterIds(config, requested, params);
  if (ranked.length === 0) {
    const fallback = config.adapters?.defaultAllow?.length ? config.adapters.defaultAllow.join(", ") : "local-docs, docs-context7, web-search";
    return `Selection:\n- No strong adapter match from query heuristics.\n- Falling back to default allowlist: ${fallback}`;
  }

  const selectedSet = new Set(selected);
  const lines = ranked
    .filter((item) => selectedSet.has(item.id))
    .map((item) => `- ${item.id} (score ${item.score})${item.reasons.length > 0 ? ` — ${item.reasons.join(", ")}` : ""}`);
  return `Selection:\n${lines.join("\n")}`;
}

export function summarizeAdapterSearchSections(sections: Array<{ adapter: string; text: string; error?: string }>): string {
  const highlights: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (section.error) continue;
    for (const rawLine of section.text.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line || /^adapter:/i.test(line) || /^query:/i.test(line) || /^repo:/i.test(line) || /^package:/i.test(line) || /^docs site:/i.test(line) || /^selection:/i.test(line)) continue;
      const normalized = line.replace(/^\d+\.\s*/, "").replace(/\(score\s+\d+\)/i, "").trim();
      if (normalized.length < 12 || seen.has(normalized)) continue;
      seen.add(normalized);
      highlights.push(`- [${section.adapter}] ${normalized}`);
      if (highlights.length >= 8) break;
    }
    if (highlights.length >= 8) break;
  }
  return highlights.length > 0 ? `Summary:\n${highlights.join("\n")}` : "Summary:\n- No synthesized highlights available.";
}
