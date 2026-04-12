import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { PantheonConfig } from "./config.js";

export interface PackageUpdateCache {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  latestPublishedAt?: string;
  checkedAt: number;
  status: "current" | "update-available" | "error" | "skipped";
  reason?: string;
}

export interface PackageUpdateReport {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  latestPublishedAt?: string;
  checkedAt?: number;
  status: "current" | "update-available" | "error" | "skipped";
  updateAvailable: boolean;
  reason?: string;
  packageRoot: string;
  localCheckout: boolean;
  cachePath: string;
  usedCache: boolean;
}

interface PackageMetadata {
  name?: string;
  version?: string;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function readPackageMetadata(): PackageMetadata {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as PackageMetadata;
  } catch {
    return { name: "oh-my-opencode-pi", version: "0.0.0" };
  }
}

function isLocalCheckout(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

function parseVersion(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string | undefined, b: string | undefined): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index++) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function resolveCachePath(config: PantheonConfig): string {
  const configured = config.updates?.cacheFile?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(getAgentDir(), configured);
  }
  return path.join(getAgentDir(), "oh-my-opencode-pi-update-check.json");
}

function readCache(cachePath: string): PackageUpdateCache | undefined {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8")) as PackageUpdateCache;
  } catch {
    return undefined;
  }
}

function writeCache(cachePath: string, cache: PackageUpdateCache): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

async function fetchLatestVersion(packageName: string, timeoutMs: number, userAgent: string, signal?: AbortSignal): Promise<{ latestVersion?: string; latestPublishedAt?: string }> {
  const controller = new AbortController();
  const relay = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", relay, { once: true });
  }
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: {
        "user-agent": userAgent,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`npm registry request failed (${response.status} ${response.statusText})`);
    }
    const payload = await response.json() as { "dist-tags"?: Record<string, string>; time?: Record<string, string> };
    const latestVersion = payload["dist-tags"]?.latest;
    return {
      latestVersion,
      latestPublishedAt: latestVersion ? payload.time?.[latestVersion] : undefined,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relay);
  }
}

export function renderPackageUpdateReport(report: PackageUpdateReport, forced = false): string {
  return [
    "Pantheon package version report",
    "",
    `Package: ${report.packageName}`,
    `Current version: ${report.currentVersion}`,
    `Latest version: ${report.latestVersion ?? "(unknown)"}`,
    `Status: ${report.status}`,
    `Update available: ${report.updateAvailable ? "yes" : "no"}`,
    `Checked at: ${report.checkedAt ? new Date(report.checkedAt).toISOString() : "(never)"}`,
    report.latestPublishedAt ? `Latest published: ${report.latestPublishedAt}` : undefined,
    `Package root: ${report.packageRoot}`,
    `Local checkout: ${report.localCheckout ? "yes" : "no"}`,
    `Cache: ${report.cachePath}`,
    `Used cache: ${report.usedCache ? "yes" : "no"}`,
    report.reason ? `Reason: ${report.reason}` : undefined,
    "",
    "Suggested next steps:",
    report.updateAvailable ? "- Update the installed package when convenient." : undefined,
    report.localCheckout ? "- Local checkout detected; automatic update notices are suppressed by default." : undefined,
    !report.updateAvailable && !report.localCheckout ? "- No action needed; the package is current or no newer release was found." : undefined,
    forced ? "- This report came from a manual refresh request." : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function checkForPackageUpdates(
  config: PantheonConfig,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<PackageUpdateReport> {
  const metadata = readPackageMetadata();
  const root = packageRoot();
  const packageName = metadata.name?.trim() || "oh-my-opencode-pi";
  const currentVersion = metadata.version?.trim() || "0.0.0";
  const localCheckout = isLocalCheckout(root);
  const cachePath = resolveCachePath(config);
  const cache = readCache(cachePath);

  if (config.updates?.enabled === false) {
    return {
      packageName,
      currentVersion,
      checkedAt: cache?.checkedAt,
      latestVersion: cache?.latestVersion,
      latestPublishedAt: cache?.latestPublishedAt,
      status: "skipped",
      updateAvailable: Boolean(cache?.latestVersion && compareVersions(currentVersion, cache.latestVersion) < 0),
      reason: "Update checks are disabled in config.",
      packageRoot: root,
      localCheckout,
      cachePath,
      usedCache: Boolean(cache),
    };
  }

  if (!options?.force && localCheckout && config.updates?.skipLocalCheckout !== false) {
    return {
      packageName,
      currentVersion,
      checkedAt: cache?.checkedAt,
      latestVersion: cache?.latestVersion,
      latestPublishedAt: cache?.latestPublishedAt,
      status: "skipped",
      updateAvailable: false,
      reason: "Local checkout detected; skipping automatic package update checks.",
      packageRoot: root,
      localCheckout,
      cachePath,
      usedCache: Boolean(cache),
    };
  }

  const intervalHours = Math.max(1, Math.floor(config.updates?.checkIntervalHours ?? 24));
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const cacheFresh = cache
    && cache.packageName === packageName
    && cache.currentVersion === currentVersion
    && typeof cache.checkedAt === "number"
    && (Date.now() - cache.checkedAt) < intervalMs;

  if (!options?.force && cacheFresh) {
    return {
      packageName,
      currentVersion,
      checkedAt: cache.checkedAt,
      latestVersion: cache.latestVersion,
      latestPublishedAt: cache.latestPublishedAt,
      status: cache.status,
      updateAvailable: Boolean(cache.latestVersion && compareVersions(currentVersion, cache.latestVersion) < 0),
      reason: cache.reason,
      packageRoot: root,
      localCheckout,
      cachePath,
      usedCache: true,
    };
  }

  try {
    const fetched = await fetchLatestVersion(packageName, config.research?.timeoutMs ?? 15000, config.research?.userAgent ?? `${packageName}/${currentVersion}`, options?.signal);
    const updateAvailable = Boolean(fetched.latestVersion && compareVersions(currentVersion, fetched.latestVersion) < 0);
    const nextCache: PackageUpdateCache = {
      packageName,
      currentVersion,
      latestVersion: fetched.latestVersion,
      latestPublishedAt: fetched.latestPublishedAt,
      checkedAt: Date.now(),
      status: updateAvailable ? "update-available" : "current",
      reason: updateAvailable ? `A newer version is available (${currentVersion} -> ${fetched.latestVersion}).` : undefined,
    };
    writeCache(cachePath, nextCache);
    return {
      packageName,
      currentVersion,
      latestVersion: nextCache.latestVersion,
      latestPublishedAt: nextCache.latestPublishedAt,
      checkedAt: nextCache.checkedAt,
      status: nextCache.status,
      updateAvailable,
      reason: nextCache.reason,
      packageRoot: root,
      localCheckout,
      cachePath,
      usedCache: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cache) {
      return {
        packageName,
        currentVersion,
        latestVersion: cache.latestVersion,
        latestPublishedAt: cache.latestPublishedAt,
        checkedAt: cache.checkedAt,
        status: cache.status,
        updateAvailable: Boolean(cache.latestVersion && compareVersions(currentVersion, cache.latestVersion) < 0),
        reason: `Update check failed; using cached data. ${message}`,
        packageRoot: root,
        localCheckout,
        cachePath,
        usedCache: true,
      };
    }
    return {
      packageName,
      currentVersion,
      status: "error",
      updateAvailable: false,
      reason: message,
      packageRoot: root,
      localCheckout,
      cachePath,
      usedCache: false,
    };
  }
}
