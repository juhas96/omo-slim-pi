import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkForPackageUpdates, compareVersions } from "../extensions/oh-my-opencode-pi/update-checker.ts";

const realFetch = globalThis.fetch;
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[AGENT_DIR_ENV];
});

test("compareVersions handles basic semver ordering", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
});

test("update checker skips local checkouts by default", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should not fetch");
  }) as typeof fetch;

  const report = await checkForPackageUpdates({ updates: { enabled: true } } as never);

  assert.equal(report.status, "skipped");
  assert.equal(report.localCheckout, true);
  assert.equal(called, false);
  assert.match(report.reason ?? "", /Local checkout detected/);
});

test("forced update checks can refresh even in a local checkout", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      "dist-tags": { latest: "0.1.1" },
      time: { "0.1.1": "2026-04-12T00:00:00.000Z" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const report = await checkForPackageUpdates({ research: { timeoutMs: 1000, userAgent: "test-agent" } } as never, { force: true });
  assert.equal(report.status, "update-available");
  assert.equal(report.usedCache, false);
  assert.equal(calls, 1);
});

test("update checker fetches latest version and reuses fresh cache", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-update-check-"));
  process.env[AGENT_DIR_ENV] = tempRoot;
  const cachePath = path.join(tempRoot, "update-cache.json");
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      "dist-tags": { latest: "0.1.1" },
      time: { "0.1.1": "2026-04-12T00:00:00.000Z" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const config = {
    updates: {
      enabled: true,
      skipLocalCheckout: false,
      cacheFile: cachePath,
      checkIntervalHours: 24,
    },
    research: {
      timeoutMs: 1000,
      userAgent: "test-agent",
    },
  } as never;

  const first = await checkForPackageUpdates(config);
  assert.equal(first.status, "update-available");
  assert.equal(first.latestVersion, "0.1.1");
  assert.equal(first.usedCache, false);
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(cachePath));

  globalThis.fetch = (async () => {
    throw new Error("network should not be used when cache is fresh");
  }) as typeof fetch;

  const second = await checkForPackageUpdates(config);
  assert.equal(second.status, "update-available");
  assert.equal(second.usedCache, true);
  assert.equal(second.latestVersion, "0.1.1");
  assert.equal(calls, 1);
});
