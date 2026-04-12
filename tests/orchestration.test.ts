import test from "node:test";
import assert from "node:assert/strict";
import {
  PantheonOrchestrationRuntime,
  createPantheonOrchestrationSnapshot,
  restorePantheonOrchestrationFromEntries,
  summarizeOrchestrationSnapshot,
} from "../extensions/oh-my-opencode-pi/orchestration.ts";

test("Pantheon orchestration runtime records hook ordering and middleware patches", () => {
  const runtime = new PantheonOrchestrationRuntime(createPantheonOrchestrationSnapshot());
  const order: string[] = [];

  runtime.use("before_agent_start", (event) => {
    order.push(`first:${event.hook}`);
    return { lastPrompt: "normalized prompt" };
  });
  runtime.use("before_agent_start", (event) => {
    order.push(`second:${event.hook}`);
  });
  runtime.use("tool_call", (event) => {
    order.push(`tool:${String(event.detail?.toolName ?? "unknown")}`);
  });

  runtime.record("before_agent_start", "prepare prompt", { prompt: "original prompt" }, "/tmp/project");
  runtime.record("tool_call", "read repo file", { toolName: "read" }, "/tmp/project");

  assert.deepEqual(order, ["first:before_agent_start", "second:before_agent_start", "tool:read"]);
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.counts.before_agent_start, 1);
  assert.equal(snapshot.counts.tool_call, 1);
  assert.equal(snapshot.lastPrompt, "normalized prompt");
  assert.equal(snapshot.lastTool, "read");
  assert.match(summarizeOrchestrationSnapshot(snapshot), /before_agent_start=1/);
  assert.match(summarizeOrchestrationSnapshot(snapshot), /tool_call=1/);
});

test("Pantheon orchestration snapshot restores from persisted custom entries", () => {
  const runtime = new PantheonOrchestrationRuntime();
  runtime.record("session_start", "startup", { reason: "startup" }, "/tmp/project");
  runtime.record("before_provider_request", "serialize payload", { provider: "anthropic" }, "/tmp/project");
  const snapshot = runtime.getSnapshot();

  const restored = restorePantheonOrchestrationFromEntries([
    { type: "custom", customType: "other", data: { noop: true } },
    { type: "custom", customType: "pantheon-orchestration", data: snapshot },
  ]);

  assert.equal(restored.counts.session_start, 1);
  assert.equal(restored.counts.before_provider_request, 1);
  assert.equal(restored.lastProvider, "anthropic");
  assert.equal(restored.lastSessionReason, "startup");
  assert.equal(restored.sequence, 2);
});
