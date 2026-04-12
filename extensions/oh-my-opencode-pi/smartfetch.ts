import { URL } from "node:url";

export type LlmsPreference = "auto" | "always" | "never";
export type SmartFetchSource = "llms-txt" | "html" | "text";

export interface SmartFetchOptions {
  timeoutMs: number;
  userAgent: string;
  signal?: AbortSignal;
  preferLlmsTxt?: LlmsPreference;
  extractMain?: boolean;
  allowCrossOriginRedirects?: boolean;
  maxChars?: number;
}

export interface SmartFetchDetails {
  requestedUrl: string;
  finalUrl: string;
  source: SmartFetchSource;
  usedLlmsTxt: boolean;
  extractedMain: boolean;
  contentType: string;
  redirects: string[];
  llmsProbeNote?: string;
}

export interface SmartFetchResult {
  text: string;
  details: SmartFetchDetails;
}

interface FetchWithRedirectsResult {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  text: string;
  redirects: string[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16)));
}

export function htmlToText(text: string): string {
  return decodeEntities(
    text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|main|aside|li|ul|ol|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

function previewText(text: string, max = 12000): string {
  const normalized = text.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function maybeNormalizeGithubBlobUrl(url: string): string {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (!match) return url;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

function looksLikeHtml(text: string, contentType?: string): boolean {
  return /html/i.test(contentType || "") || /<(?:!doctype|html|body|main|article|head|title)\b/i.test(text);
}

function extractTagContent(html: string, tagName: string): string | undefined {
  const match = html.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1];
}

function extractCandidateHtml(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern);
  return match?.[1]?.trim();
}

function stripBoilerplate(html: string): string {
  return html
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");
}

export function extractMainContentFromHtml(html: string, finalUrl: string): { title?: string; content: string; extractedMain: boolean } {
  const title = extractTagContent(html, "title") ? htmlToText(extractTagContent(html, "title") ?? "") : undefined;
  const cleaned = stripBoilerplate(html);
  const candidates = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<(?:div|section)[^>]+(?:id|class)=["'][^"']*(?:content|docs|doc|markdown|article|main)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ];

  for (const candidate of candidates) {
    const fragment = extractCandidateHtml(cleaned, candidate);
    if (!fragment) continue;
    const text = htmlToText(fragment);
    if (text.length >= 240) {
      return { title, content: text, extractedMain: candidate.source !== candidates[candidates.length - 1].source };
    }
  }

  const fallback = htmlToText(cleaned);
  const withUrl = title ? `${title}\nURL: ${finalUrl}\n\n${fallback}` : `URL: ${finalUrl}\n\n${fallback}`;
  return { title, content: withUrl.trim(), extractedMain: false };
}

function isDocsLikeUrl(url: URL): boolean {
  return /^docs\./i.test(url.hostname)
    || /^developer\./i.test(url.hostname)
    || /^dev\./i.test(url.hostname)
    || /^wiki\./i.test(url.hostname)
    || /\b(docs|documentation|guide|guides|reference|api)\b/i.test(url.pathname);
}

function withTimeout<T>(timeoutMs: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", relay, { once: true });
  }
  return run(controller.signal).finally(() => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relay);
  });
}

async function fetchWithRedirects(
  inputUrl: string,
  options: SmartFetchOptions,
  allowCrossOriginRedirects = false,
): Promise<FetchWithRedirectsResult> {
  const requestedUrl = maybeNormalizeGithubBlobUrl(inputUrl.trim());
  return withTimeout(options.timeoutMs, options.signal, async (signal) => {
    let currentUrl = requestedUrl;
    const redirects: string[] = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": options.userAgent,
          accept: "text/plain, text/markdown, text/html, application/json;q=0.9, */*;q=0.2",
        },
        signal,
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect response from ${currentUrl} did not include a Location header.`);
        const nextUrl = new URL(location, currentUrl).toString();
        const from = new URL(currentUrl);
        const to = new URL(nextUrl);
        if (!allowCrossOriginRedirects && from.origin !== to.origin) {
          throw new Error(`Cross-origin redirect blocked: ${currentUrl} -> ${nextUrl}`);
        }
        redirects.push(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Request failed (${response.status} ${response.statusText}) for ${currentUrl}`);
      }

      const contentType = response.headers.get("content-type")?.trim() || "unknown";
      const text = await response.text();
      return {
        requestedUrl,
        finalUrl: currentUrl,
        contentType,
        text,
        redirects,
      };
    }

    throw new Error(`Too many redirects while fetching ${requestedUrl}`);
  });
}

async function probeLlmsText(requestedUrl: string, options: SmartFetchOptions): Promise<{ result?: FetchWithRedirectsResult; note?: string }> {
  const base = new URL(maybeNormalizeGithubBlobUrl(requestedUrl));
  const candidates = [new URL("/llms-full.txt", base.origin).toString(), new URL("/llms.txt", base.origin).toString()];
  for (const candidate of candidates) {
    try {
      const fetched = await fetchWithRedirects(candidate, options, false);
      if (looksLikeHtml(fetched.text, fetched.contentType)) {
        return { note: `${candidate} returned HTML/login content; falling back to the requested page.` };
      }
      return { result: fetched };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Cross-origin redirect blocked/i.test(message)) return { note: `${candidate} redirected across origins and was ignored for safety.` };
      if (!/Request failed \(404/i.test(message)) return { note: `${candidate} was unavailable (${message}); falling back to the requested page.` };
    }
  }
  return { note: "No llms.txt resource was available; fetched the requested page instead." };
}

export async function smartFetch(url: string, options: SmartFetchOptions): Promise<SmartFetchResult> {
  const normalizedUrl = maybeNormalizeGithubBlobUrl(url.trim());
  const preferLlmsTxt = options.preferLlmsTxt ?? "auto";
  const shouldProbeLlms = preferLlmsTxt === "always"
    || (preferLlmsTxt === "auto" && isDocsLikeUrl(new URL(normalizedUrl)));

  let llmsProbeNote: string | undefined;
  if (shouldProbeLlms) {
    const probe = await probeLlmsText(normalizedUrl, options);
    llmsProbeNote = probe.note;
    if (probe.result) {
      const body = previewText(probe.result.text, Math.max(1000, Math.floor(options.maxChars ?? 12000)));
      const text = [
        `Requested URL: ${normalizedUrl}`,
        `Final URL: ${probe.result.finalUrl}`,
        "Source: llms.txt",
        "Used llms.txt: yes",
        `Content-Type: ${probe.result.contentType}`,
        probe.result.redirects.length > 0 ? `Redirects: ${probe.result.redirects.join(" -> ")}` : undefined,
        llmsProbeNote ? `llms.txt probe: ${llmsProbeNote}` : undefined,
        "",
        body,
      ].filter((line): line is string => Boolean(line)).join("\n");
      return {
        text,
        details: {
          requestedUrl: normalizedUrl,
          finalUrl: probe.result.finalUrl,
          source: "llms-txt",
          usedLlmsTxt: true,
          extractedMain: false,
          contentType: probe.result.contentType,
          redirects: probe.result.redirects,
          llmsProbeNote,
        },
      };
    }
  }

  const fetched = await fetchWithRedirects(normalizedUrl, options, options.allowCrossOriginRedirects === true);
  const isHtml = looksLikeHtml(fetched.text, fetched.contentType);
  if (isHtml) {
    const extracted = extractMainContentFromHtml(fetched.text, fetched.finalUrl);
    const body = previewText(extracted.content, Math.max(1000, Math.floor(options.maxChars ?? 12000)));
    const text = [
      extracted.title ? `Title: ${extracted.title}` : undefined,
      `Requested URL: ${normalizedUrl}`,
      `Final URL: ${fetched.finalUrl}`,
      "Source: html",
      "Used llms.txt: no",
      `Extracted main content: ${options.extractMain === false ? "no (disabled)" : extracted.extractedMain ? "yes" : "fallback"}`,
      `Content-Type: ${fetched.contentType}`,
      fetched.redirects.length > 0 ? `Redirects: ${fetched.redirects.join(" -> ")}` : undefined,
      llmsProbeNote ? `llms.txt probe: ${llmsProbeNote}` : undefined,
      "",
      options.extractMain === false ? previewText(htmlToText(fetched.text), Math.max(1000, Math.floor(options.maxChars ?? 12000))) : body,
    ].filter((line): line is string => Boolean(line)).join("\n");
    return {
      text,
      details: {
        requestedUrl: normalizedUrl,
        finalUrl: fetched.finalUrl,
        source: "html",
        usedLlmsTxt: false,
        extractedMain: options.extractMain === false ? false : extracted.extractedMain,
        contentType: fetched.contentType,
        redirects: fetched.redirects,
        llmsProbeNote,
      },
    };
  }

  const body = previewText(fetched.text, Math.max(1000, Math.floor(options.maxChars ?? 12000)));
  const text = [
    `Requested URL: ${normalizedUrl}`,
    `Final URL: ${fetched.finalUrl}`,
    "Source: text",
    "Used llms.txt: no",
    `Content-Type: ${fetched.contentType}`,
    fetched.redirects.length > 0 ? `Redirects: ${fetched.redirects.join(" -> ")}` : undefined,
    llmsProbeNote ? `llms.txt probe: ${llmsProbeNote}` : undefined,
    "",
    body,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return {
    text,
    details: {
      requestedUrl: normalizedUrl,
      finalUrl: fetched.finalUrl,
      source: "text",
      usedLlmsTxt: false,
      extractedMain: false,
      contentType: fetched.contentType,
      redirects: fetched.redirects,
      llmsProbeNote,
    },
  };
}
