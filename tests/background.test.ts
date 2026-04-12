import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { enqueueBackgroundSpec, listBackgroundTasks, retryBackgroundTask } from "../extensions/oh-my-opencode-pi/background.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for background task");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("background task spec can complete and retry via the detached runner", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-background-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    background: { enabled: true, logDir: taskDir, maxConcurrent: 1 },
    workflow: { persistTodos: false },
  }, null, 2));

  const fakePi = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePi, `
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "background ok" }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const first = enqueueBackgroundSpec(projectDir, {
      agent: "fixer",
      task: "Run fake background task",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [fakePi],
      retryOnEmpty: false,
    }, {
      taskDir,
      randomId: () => "bg_first",
      maxConcurrent: 1,
    });

    await waitFor(() => listBackgroundTasks(taskDir).some((task) => task.id === first.id && task.status === "completed"));
    const completed = listBackgroundTasks(taskDir).find((task) => task.id === first.id);
    assert.equal(completed?.status, "completed");
    assert.match(completed?.summary ?? "", /background ok/i);

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
