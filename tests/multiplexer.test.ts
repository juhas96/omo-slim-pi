import test from "node:test";
import assert from "node:assert/strict";
import { getMultiplexerWindowName, renderMultiplexerStatus } from "../extensions/oh-my-opencode-pi/background.ts";

test("multiplexer status uses project-scoped window names by default", () => {
  const cwd = "/tmp/demo-project";
  const windowName = getMultiplexerWindowName(cwd, { tmux: true, windowName: "pantheon-bg", projectScopedWindow: true } as never);
  assert.match(windowName, /^pantheon-bg-demo-project-/);

  const shared = getMultiplexerWindowName(cwd, { tmux: true, windowName: "pantheon-bg", projectScopedWindow: false } as never);
  assert.equal(shared, "pantheon-bg");

  const status = renderMultiplexerStatus(cwd, { tmux: true, layout: "main-vertical", reuseWindow: true, projectScopedWindow: true, focusOnSpawn: false } as never, [
    { id: "bg1", agent: "fixer", task: "demo", status: "running", createdAt: Date.now(), logPath: "/tmp/demo.log", resultPath: "/tmp/demo.result.json", paneId: "%1" },
  ] as never);
  assert.match(status, /window:/);
  assert.match(status, /projectScopedWindow: yes/);
  assert.match(status, /bg1: fixer/);
});
