import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanupBackgroundArtifacts,
  enqueueBackgroundSpec,
  getBackgroundSessionKey,
  isTaskStale,
  listBackgroundTasks,
  reconcileBackgroundTasks,
  renderBackgroundResult,
  renderBackgroundWatch,
  retryBackgroundTask,
} from "../extensions/oh-my-opencode-pi/background.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for background task");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("background task spec can complete, reuse active sessions, and retry via the detached runner", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    background: { enabled: true, logDir: taskDir, maxConcurrent: 1, reuseSessions: true, heartbeatIntervalMs: 250, staleAfterMs: 5000 },
    workflow: { persistTodos: false },
  }, null, 2));

  const slowPi = path.join(tempRoot, "slow-pi.mjs");
  fs.writeFileSync(slowPi, `
    setTimeout(() => {
      console.log(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "background ok" }],
          model: "fake/model",
          stopReason: "end_turn"
        }
      }));
    }, 700);
  `);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const first = enqueueBackgroundSpec(projectDir, {
      agent: "fixer",
      task: "Run fake background task",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [slowPi],
      retryOnEmpty: false,
    }, {
      taskDir,
      randomId: () => "bg_first",
      maxConcurrent: 1,
    });

    await waitFor(() => listBackgroundTasks(taskDir).some((task) => task.id === first.id && task.status === "running"));
    const reused = enqueueBackgroundSpec(projectDir, {
      agent: "fixer",
      task: "Run fake background task",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [slowPi],
      retryOnEmpty: false,
    }, {
      taskDir,
      randomId: () => "bg_duplicate",
      maxConcurrent: 1,
    });
    assert.equal(reused.id, first.id);
    assert.equal(reused.reusedFrom, first.id);
    assert.equal(reused.sessionKey, getBackgroundSessionKey("fixer", projectDir, "Run fake background task"));

    await waitFor(() => listBackgroundTasks(taskDir).some((task) => task.id === first.id && task.status === "completed"));
    const completed = listBackgroundTasks(taskDir).find((task) => task.id === first.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.summary ?? "", /background ok/i);
    assert.ok((completed?.heartbeatAt ?? 0) >= (completed?.startedAt ?? 0));

    const retried = retryBackgroundTask(projectDir, completed!, {
      taskDir,
      randomId: () => "bg_retry",
    });
    assert.ok(retried);

    await waitFor(() => listBackgroundTasks(taskDir).some((task) => task.id === retried!.id && task.status === "completed"));
    const retriedDone = listBackgroundTasks(taskDir).find((task) => task.id === retried!.id);
    assert.equal(retriedDone?.status, "completed");
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("background runner completes soon after a final assistant message even if the child lingers", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-linger-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    background: { enabled: true, logDir: taskDir, maxConcurrent: 1, reuseSessions: false, heartbeatIntervalMs: 250, staleAfterMs: 5000 },
    fallback: { finalMessageGraceMs: 50 },
    workflow: { persistTodos: false },
  }, null, 2));

  const lingerPi = path.join(tempRoot, "linger-pi.mjs");
  fs.writeFileSync(lingerPi, `
    const task = process.argv[process.argv.length - 1] || "";
    process.on("SIGTERM", () => process.exit(0));
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "background ok:" + task.slice(0, 30) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
    setInterval(() => {}, 1000);
  `);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const startedAt = Date.now();
    const task = enqueueBackgroundSpec(projectDir, {
      agent: "fixer",
      task: "Run lingering background task",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [lingerPi],
      retryOnEmpty: false,
      timeoutMs: 5000,
    }, {
      taskDir,
      randomId: () => "bg_linger",
      maxConcurrent: 1,
    });

    await waitFor(() => listBackgroundTasks(taskDir).some((entry) => entry.id === task.id && entry.status === "completed"), 7000);
    const completed = listBackgroundTasks(taskDir).find((entry) => entry.id === task.id);
    const durationMs = Date.now() - startedAt;
    assert.equal(completed?.status, "completed");
    assert.match(completed?.summary ?? "", /background ok:/i);
    assert.ok(durationMs < 1200, `Expected configurable fast background completion after final message, got ${durationMs}ms`);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("background runner re-arms the timeout while the child keeps emitting progress", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-progress-timeout-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    background: { enabled: true, logDir: taskDir, maxConcurrent: 1, reuseSessions: false, heartbeatIntervalMs: 250, staleAfterMs: 5000 },
    fallback: { timeoutMs: 250 },
    workflow: { persistTodos: false },
  }, null, 2));

  const progressPi = path.join(tempRoot, "progress-pi.mjs");
  fs.writeFileSync(progressPi, `
    const task = process.argv[process.argv.length - 1] || "";
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      console.log(JSON.stringify({
        type: "tool_result_end",
        message: {
          role: "tool",
          content: [{ type: "text", text: "progress:" + step }]
        }
      }));
      if (step >= 4) {
        clearInterval(timer);
        console.log(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "background ok:" + task.slice(0, 30) }],
            model: "fake/model",
            stopReason: "end_turn"
          }
        }));
        process.exit(0);
      }
    }, 100);
  `);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const startedAt = Date.now();
    const task = enqueueBackgroundSpec(projectDir, {
      agent: "fixer",
      task: "Run progress background task",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [progressPi],
      retryOnEmpty: false,
      timeoutMs: 250,
    }, {
      taskDir,
      randomId: () => "bg_progress",
      maxConcurrent: 1,
    });

    await waitFor(() => listBackgroundTasks(taskDir).some((entry) => entry.id === task.id && entry.status === "completed"), 4000);
    const completed = listBackgroundTasks(taskDir).find((entry) => entry.id === task.id);
    const durationMs = Date.now() - startedAt;
    assert.equal(completed?.status, "completed");
    assert.match(completed?.summary ?? "", /background ok:/i);
    assert.ok(durationMs >= 350, `Expected run to outlast the base timeout because progress kept arriving, got ${durationMs}ms`);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("background runner avoids CLI --tools when the agent depends on extension tools", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-tools-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    background: { enabled: true, logDir: taskDir, maxConcurrent: 1, reuseSessions: false, heartbeatIntervalMs: 250, staleAfterMs: 5000 },
    workflow: { persistTodos: false },
  }, null, 2));

  const argvPi = path.join(tempRoot, "argv-pi.mjs");
  fs.writeFileSync(argvPi, `
    const args = process.argv.slice(2);
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify(args) }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const task = enqueueBackgroundSpec(projectDir, {
      agent: "librarian",
      task: "Inspect background CLI args",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [argvPi],
      tools: ["read", "grep", "find", "ls", "bash", "pantheon_fetch"],
      systemPrompt: "Background librarian",
      retryOnEmpty: false,
    }, {
      taskDir,
      randomId: () => "bg_tools",
      maxConcurrent: 1,
    });

    await waitFor(() => listBackgroundTasks(taskDir).some((entry) => entry.id === task.id && entry.status === "completed"));
    const completed = listBackgroundTasks(taskDir).find((entry) => entry.id === task.id);
    const firstPart = completed?.result?.messages?.[0]?.content?.[0];
    const argsText = firstPart && typeof firstPart === "object" && "text" in firstPart ? String(firstPart.text ?? "") : "";
    assert.doesNotMatch(argsText, /"--tools"/);
    assert.match(argsText, /Tool policy:/);
    assert.match(argsText, /pantheon_fetch/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("cleanup can keep the newest terminal task without counting active jobs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-cleanup-keep-"));
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(taskDir, { recursive: true });

  const writeTask = (id: string, status: "queued" | "running" | "completed" | "failed" | "cancelled", createdAt: number) => {
    const resultPath = path.join(taskDir, `${id}.result.json`);
    const logPath = path.join(taskDir, `${id}.log`);
    const specPath = path.join(taskDir, `${id}.spec.json`);
    fs.writeFileSync(logPath, `${id} log\n`);
    fs.writeFileSync(specPath, JSON.stringify({ id }, null, 2));
    fs.writeFileSync(resultPath, JSON.stringify({
      id,
      agent: "explorer",
      task: `Task ${id}`,
      status,
      createdAt,
      heartbeatAt: createdAt,
      logPath,
      resultPath,
      specPath,
    }, null, 2));
    return { resultPath, logPath, specPath };
  };

  const running = writeTask("running", "running", 4_000);
  const failed = writeTask("failed", "failed", 3_000);
  const completed = writeTask("completed", "completed", 2_000);

  const result = cleanupBackgroundArtifacts(taskDir, { keepCount: 1 });
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 2);
  assert.deepEqual(listBackgroundTasks(taskDir).map((task) => task.id), ["running", "failed"]);
  assert.equal(fs.existsSync(running.resultPath), true);
  assert.equal(fs.existsSync(failed.resultPath), true);
  assert.equal(fs.existsSync(completed.resultPath), false);
  assert.equal(fs.existsSync(completed.logPath), false);
  assert.equal(fs.existsSync(completed.specPath), false);
});

test("cleanup removes all terminal background artifacts when keepCount is zero", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-cleanup-all-"));
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(taskDir, { recursive: true });

  const writeTask = (id: string, status: "queued" | "running" | "completed" | "failed" | "cancelled", createdAt: number) => {
    const resultPath = path.join(taskDir, `${id}.result.json`);
    const logPath = path.join(taskDir, `${id}.log`);
    const specPath = path.join(taskDir, `${id}.spec.json`);
    fs.writeFileSync(logPath, `${id} log\n`);
    fs.writeFileSync(specPath, JSON.stringify({ id }, null, 2));
    fs.writeFileSync(resultPath, JSON.stringify({
      id,
      agent: "fixer",
      task: `Task ${id}`,
      status,
      createdAt,
      heartbeatAt: createdAt,
      logPath,
      resultPath,
      specPath,
    }, null, 2));
  };

  writeTask("running", "running", 4_000);
  writeTask("failed", "failed", 3_000);
  writeTask("completed", "completed", 2_000);
  writeTask("cancelled", "cancelled", 1_000);

  const result = cleanupBackgroundArtifacts(taskDir, { keepCount: 0 });
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 1);
  assert.deepEqual(listBackgroundTasks(taskDir).map((task) => task.id), ["running"]);
});

test("listBackgroundTasks ignores corrupt task artifacts instead of throwing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-corrupt-"));
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(taskDir, { recursive: true });

  const validPath = path.join(taskDir, "good.result.json");
  fs.writeFileSync(validPath, JSON.stringify({
    id: "good",
    agent: "explorer",
    task: "Healthy task",
    status: "completed",
    createdAt: 1,
    heartbeatAt: 1,
    logPath: path.join(taskDir, "good.log"),
    resultPath: validPath,
  }, null, 2));
  fs.writeFileSync(path.join(taskDir, "broken.result.json"), "{ not-json\n", "utf8");

  const tasks = listBackgroundTasks(taskDir);
  assert.deepEqual(tasks.map((task) => task.id), ["good"]);
});

test("background reconciliation marks stale jobs and watch views include heartbeat metadata", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-stale-"));
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const resultPath = path.join(taskDir, "stale.result.json");
  const logPath = path.join(taskDir, "stale.log");
  fs.writeFileSync(logPath, "hello\nworld\n");
  fs.writeFileSync(resultPath, JSON.stringify({
    id: "stale",
    agent: "explorer",
    task: "Investigate stale heartbeat",
    status: "running",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    heartbeatAt: Date.now() - 40_000,
    sessionKey: "explorer:abc123",
    logPath,
    resultPath,
    pid: process.pid,
  }, null, 2));

  const [updated] = reconcileBackgroundTasks(taskDir, undefined, 5_000);
  assert.equal(updated?.status, "failed");
  assert.match(updated?.summary ?? "", /stale/i);
  assert.ok(isTaskStale({ ...updated!, status: "running", heartbeatAt: Date.now() - 10_000 } as never, 5_000));

  const watchedTask = { ...updated!, watchCount: 2, heartbeatAt: Date.now() - 2_000, startedAt: Date.now() - 12_000 };
  const watch = renderBackgroundWatch(watchedTask, 10, 5_000);
  assert.match(watch, /Session key:/);
  assert.match(watch, /Heartbeat:/);
  assert.match(watch, /stale • failed • explorer • 12s/);
  assert.match(watch, /Next:/);
  assert.match(watch, /Recent log:/);

  const result = renderBackgroundResult(watchedTask, { includeLogTail: true, logLines: 5, staleAfterMs: 5_000 });
  assert.match(result, /Next:/);
  assert.match(result, /\/pantheon-retry stale/);
  assert.match(result, /Recent log:/);
});
