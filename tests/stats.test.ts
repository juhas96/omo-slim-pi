import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPantheonStats, recordAdapterUsage, recordBackgroundStatus, recordCategoryRun, renderPantheonStats } from "../extensions/oh-my-opencode-pi/stats.ts";

test("Pantheon stats accumulate categories, adapters, and background outcomes", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-stats-"));
  const config = {} as never;

  recordCategoryRun(tempRoot, config, "delegate", "success", 1200, "single", "fixer");
  recordCategoryRun(tempRoot, config, "council", "failed", 900, "council");
  recordAdapterUsage(tempRoot, config, "local-docs", "search", false);
  recordAdapterUsage(tempRoot, config, "github-code-search", "fetch", true);
  recordBackgroundStatus(tempRoot, config, "queued", "fixer:bg1");
  recordBackgroundStatus(tempRoot, config, "completed", "fixer:bg1");

  const stats = readPantheonStats(tempRoot, config);
  assert.equal(stats.categories.delegate.success, 1);
  assert.equal(stats.categories.council.failed, 1);
  assert.equal(stats.agents.fixer.success, 1);
  assert.equal(stats.adapters["local-docs"].searches, 1);
  assert.equal(stats.adapters["github-code-search"].failures, 1);
  assert.equal(stats.background.completed, 1);
  assert.match(renderPantheonStats(stats), /delegate|local-docs|Background/);
  assert.ok(fs.existsSync(path.join(tempRoot, ".oh-my-opencode-pi-stats.json")));
});
