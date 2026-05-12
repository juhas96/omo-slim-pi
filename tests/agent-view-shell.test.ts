import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";
import { validatePantheonConfig } from "../extensions/oh-my-opencode-pi/config.ts";
import { buildDoctorReport } from "../extensions/oh-my-opencode-pi/reports.ts";
import {
  RUN_STATUSES,
  FakeTerminalBackend,
  createTemporarySpecialist,
  evaluateAgentViewLaunchPolicy,
  applyAgentViewChanges,
  cleanupAgentViewWorktree,
  detectAgentViewDiff,
  markAgentViewRunStale,
  prepareAgentViewWorktree,
  pruneAgentViewRuns,
  recordAgentViewFallbackAttempts,
  refreshAgentViewSummary,
  resolveAgentViewRunModel,
  resolveAgentViewSpecialist,
  attachAgentViewRun,
  controlAgentViewRun,
  createNoopAgentViewRun,
  deleteAgentViewRun,
  ensureAgentViewRegistry,
  detachAgentViewRun,
  groupAgentViewRunsForUi,
  groupGlobalAgentViewRunsByProject,
  launchAgentViewCouncilGroup,
  launchAgentViewRunGroup,
  launchReadOnlyAgentViewRun,
  listAgentViewRuns,
  readAgentViewRun,
  registerAgentViewProject,
  resolveAgentViewProjectLaunch,
  resolveAgentViewShorthandDispatch,
  stopAgentViewRun,
} from "../extensions/oh-my-opencode-pi/agent-view.ts";

function registerExtension() {
  const tools: string[] = [];
  const toolSpecs = new Map<string, any>();
  const commands = new Map<string, any>();
  const fakePi = {
    on() {},
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
      toolSpecs.set(tool.name, tool);
    },
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
  };
  extension(fakePi as never);
  return { tools, toolSpecs, commands };
}

function fakeContext(cwd = process.cwd()) {
  let editorText = "";
  const notifications: string[] = [];
  return {
    ctx: {
      cwd,
      hasUI: false,
      ui: {
        setEditorText(text: string) {
          editorText = text;
        },
        setWidget() {},
        setStatus() {},
        notify(message: string) {
          notifications.push(message);
        },
      },
    },
    get editorText() {
      return editorText;
    },
    notifications,
  };
}

test("/pantheon-agent-view and /agents open an empty Agent View", async () => {
  const { commands } = registerExtension();
  assert.ok(commands.has("pantheon-agent-view"));
  assert.ok(commands.has("agents"));

  const view = fakeContext();
  await commands.get("pantheon-agent-view").handler("", view.ctx);
  assert.match(view.editorText, /Agent View/);
  assert.match(view.editorText, /No Runs/i);

  const alias = fakeContext();
  await commands.get("agents").handler("", alias.ctx);
  assert.match(alias.editorText, /Agent View/);
  assert.match(alias.editorText, /No Runs/i);
});

test("Agent View config validates through defaults", () => {
  const defaults = validatePantheonConfig({});
  assert.equal(defaults.config.agentView?.enabled, true);
  assert.equal(defaults.config.agentView?.storage?.projectArtifactDir, ".pi/agent-view");
  assert.equal(defaults.config.agentView?.supervisor?.scope, "project");
  assert.equal(defaults.config.agentView?.terminal?.backend, "node-pty");
  assert.equal(defaults.config.agentView?.terminal?.degradedMode, "detail-pane");
  assert.equal(defaults.config.agentView?.policy?.requireWriteConfirmation, true);

  const result = validatePantheonConfig({
    agentView: {
      enabled: false,
      storage: { projectArtifactDir: ".custom-agent-view", userArtifactDir: "custom-agent-view" },
      supervisor: { scope: "user", socketDir: "custom-agent-view/sockets", maxConcurrentRuns: 4, maxConcurrentWriteRuns: 2 },
      terminal: { backend: "stdio", degradedMode: "disabled", rawPtyRecording: true },
      policy: { requireWriteConfirmation: false, maxNestingDepth: 0, loadFullExtensionInRuns: true },
    },
  });

  assert.equal(result.config.agentView?.enabled, false);
  assert.equal(result.config.agentView?.storage?.projectArtifactDir, ".custom-agent-view");
  assert.equal(result.config.agentView?.supervisor?.scope, "user");
  assert.equal(result.config.agentView?.supervisor?.maxConcurrentRuns, 4);
  assert.equal(result.config.agentView?.terminal?.backend, "stdio");
  assert.equal(result.config.agentView?.terminal?.rawPtyRecording, true);
  assert.equal(result.config.agentView?.policy?.requireWriteConfirmation, false);
});

test("Agent View tools are registered with canonical names", () => {
  const { tools } = registerExtension();
  for (const name of [
    "agent_view_launch",
    "agent_view_launch_group",
    "agent_view_list",
    "agent_view_status",
    "agent_view_reply",
    "agent_view_stop",
    "agent_view_delete",
    "agent_view_result",
    "agent_view_diff",
    "agent_view_apply",
    "agent_view_register",
    "agent_view_doctor",
  ]) {
    assert.ok(tools.includes(name), `expected ${name} to be registered`);
  }
});

test("doctor output reports Agent View config, storage, socket, supervisor, PTY/backend, and degraded mode", () => {
  const config = validatePantheonConfig({});
  const report = buildDoctorReport({
    cwd: process.cwd(),
    config,
    adapterHealth: [],
    tmuxAvailable: false,
    inTmux: false,
    backgroundDir: ".tasks",
    backgroundDirExists: false,
    debugDir: ".debug",
    debugDirExists: false,
    workflowStatePath: ".workflow.json",
    workflowStateExists: false,
    taskCount: 0,
  });

  assert.match(report, /Agent View:/);
  assert.match(report, /Config:/);
  assert.match(report, /Storage:/);
  assert.match(report, /Socket:/);
  assert.match(report, /Supervisor:/);
  assert.match(report, /PTY\/backend:/);
  assert.match(report, /Degraded mode:/);
});

test("Agent View registry persists empty Run lifecycle records", () => {
  assert.deepEqual(RUN_STATUSES, ["queued", "starting", "running", "needs_input", "idle", "completed", "failed", "stopped", "stale"]);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-registry-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({
    agentView: {
      storage: {
        projectArtifactDir: path.join(projectDir, ".agent-view"),
        userArtifactDir: path.join(tempRoot, "user-agent-view"),
      },
      supervisor: { socketDir: path.join(tempRoot, "sockets") },
    },
  }).config;

  const registry = ensureAgentViewRegistry(projectDir, config);
  assert.ok(fs.existsSync(registry.projectRegistryPath));
  assert.ok(fs.existsSync(registry.userProjectIndexPath));
  assert.ok(fs.existsSync(registry.paths.socketDir));

  const created = createNoopAgentViewRun(projectDir, config, { task: "prove lifecycle" });
  assert.equal(created.status, "idle");
  assert.equal(created.attempts.length, 1);
  assert.equal(created.runGroups.length, 0);
  assert.ok(created.artifacts.some((artifact) => artifact.type === "event_log"));
  assert.ok(fs.existsSync(created.eventLogPath));

  const listed = listAgentViewRuns(projectDir, config);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.runId, created.runId);

  const recovered = readAgentViewRun(projectDir, config, created.runId);
  assert.equal(recovered?.runId, created.runId);
  assert.equal(recovered?.project.cwd, projectDir);

  const stopped = stopAgentViewRun(projectDir, config, created.runId);
  assert.equal(stopped?.status, "stopped");

  const deleted = deleteAgentViewRun(projectDir, config, created.runId, { retain: true });
  assert.equal(deleted?.deleted, true);
  assert.equal(listAgentViewRuns(projectDir, config).length, 0);
  assert.equal(readAgentViewRun(projectDir, config, created.runId, { includeDeleted: true })?.deleted, true);
});

test("read-only project Run launches from tool and /agents UI paths with persisted session, event log, and result metadata", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-launch-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), JSON.stringify({
    agentView: {
      storage: {
        projectArtifactDir: path.join(projectDir, ".agent-view"),
        userArtifactDir: path.join(tempRoot, "user-agent-view"),
      },
      supervisor: { socketDir: path.join(tempRoot, "sockets") },
    },
  }));

  const { toolSpecs, commands } = registerExtension();
  const launch = await toolSpecs.get("agent_view_launch").execute("call-1", { task: "inspect the project", specialist: "explorer" }, undefined, undefined, { cwd: projectDir });
  assert.equal(launch.isError, false);
  const run = launch.details.run;
  assert.equal(run.status, "completed");
  assert.equal(run.project.cwd, projectDir);
  assert.ok(run.artifacts.some((artifact: any) => artifact.type === "session" && fs.existsSync(artifact.path)));
  assert.ok(fs.existsSync(run.eventLogPath));
  assert.equal(run.result.finalMessageRef.runId, run.runId);
  assert.equal(run.result.summary, null);
  assert.equal(run.write, false);

  const list = await toolSpecs.get("agent_view_list").execute("call-2", {}, undefined, undefined, { cwd: projectDir });
  assert.match(list.content[0].text, new RegExp(run.runId));

  const status = await toolSpecs.get("agent_view_status").execute("call-3", { runId: run.runId }, undefined, undefined, { cwd: projectDir });
  const result = await toolSpecs.get("agent_view_result").execute("call-4", { runId: run.runId }, undefined, undefined, { cwd: projectDir });
  assert.equal(status.details.run.status, result.details.run.status);
  assert.equal(result.details.run.status, "completed");

  const ui = fakeContext(projectDir);
  await commands.get("agents").handler("inspect through UI", ui.ctx);
  assert.match(ui.editorText, /inspect through UI/);
  assert.match(ui.editorText, /completed/);
});

test("TerminalBackend attach and sidecar control support attach, detach, IO, stop, auth, and degraded diagnostics", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-terminal-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({
    agentView: {
      storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user-agent-view") },
      supervisor: { socketDir: path.join(tempRoot, "sockets") },
    },
  }).config;
  const run = createNoopAgentViewRun(projectDir, config, { task: "attach me" });
  const backend = new FakeTerminalBackend();

  backend.spawn(run);
  const attached = attachAgentViewRun(projectDir, config, run.runId, backend);
  assert.equal(attached.mode, "terminal");
  backend.resize(run.runId, { cols: 120, rows: 40 });
  backend.input(run.runId, "hello");
  assert.match(backend.output(run.runId), /hello/);

  const reply = controlAgentViewRun(projectDir, config, run.runId, { token: run.controlToken!, type: "reply", message: "continue" }, backend);
  assert.equal(reply.ok, true);
  const steer = controlAgentViewRun(projectDir, config, run.runId, { token: run.controlToken!, type: "steer", message: "focus" }, backend);
  assert.equal(steer.ok, true);
  const followUp = controlAgentViewRun(projectDir, config, run.runId, { token: run.controlToken!, type: "follow_up", message: "next" }, backend);
  assert.equal(followUp.ok, true);
  const unauthorized = controlAgentViewRun(projectDir, config, run.runId, { token: "wrong", type: "reply", message: "no" }, backend);
  assert.equal(unauthorized.ok, false);

  const detached = detachAgentViewRun(projectDir, config, run.runId, backend);
  assert.equal(detached.mode, "detail-pane");
  const stopped = controlAgentViewRun(projectDir, config, run.runId, { token: run.controlToken!, type: "stop" }, backend);
  assert.equal(stopped.status, "stopped");
  assert.equal(backend.diagnostics(run.runId).stopped, true);

  const failedBackend = new FakeTerminalBackend({ failAttach: true });
  failedBackend.spawn(run);
  const degraded = attachAgentViewRun(projectDir, config, run.runId, failedBackend);
  assert.equal(degraded.mode, "detail-pane");
  assert.match(degraded.diagnostic ?? "", /PTY attach unavailable/);
});

test("Specialist resolution honors session/launch, project, user, bundled precedence and temporary schema/model rules", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-specialists-"));
  const projectDir = path.join(tempRoot, "project");
  const agentDir = path.join(tempRoot, "agent");
  fs.mkdirSync(path.join(projectDir, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: user scout\nmodel: openai/user\n---\nUser prompt");
  fs.writeFileSync(path.join(projectDir, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: project scout\nmodel: openai/project\n---\nProject prompt");

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const project = resolveAgentViewSpecialist(projectDir, "scout");
    assert.equal(project?.source, "project");
    assert.equal(project?.model, "openai/project");

    const session = resolveAgentViewSpecialist(projectDir, "scout", {
      sessionSpecialists: [createTemporarySpecialist({ name: "scout", description: "session scout", systemPrompt: "Session prompt", model: "openai/session", noTools: true, options: ["--fast"] })],
    });
    assert.equal(session?.source, "session");
    assert.equal(session?.noTools, true);
    assert.deepEqual(session?.options, ["--fast"]);

    const launch = resolveAgentViewSpecialist(projectDir, "scout", {
      launchSpecialist: { name: "scout", description: "launch scout", systemPrompt: "Launch prompt", model: "openai/launch" },
    });
    assert.equal(launch?.source, "launch");
    assert.equal(resolveAgentViewRunModel(launch!, { model: "openai/override" }, ["openai/fallback"]), "openai/override");
    assert.equal(resolveAgentViewRunModel(launch!, {}, ["openai/fallback"]), "openai/launch");
    assert.equal(resolveAgentViewRunModel({ ...launch!, model: undefined }, {}, ["openai/fallback"]), "openai/fallback");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("Agent View policy gates write/user-scope/nesting/stale behavior and queues by concurrency", () => {
  const config = validatePantheonConfig({
    agentView: {
      supervisor: { scope: "project", maxConcurrentRuns: 1, maxConcurrentWriteRuns: 1 },
      policy: { requireWriteConfirmation: true, maxNestingDepth: 1 },
    },
  }).config;

  assert.deepEqual(evaluateAgentViewLaunchPolicy(config, { write: false, scope: "project", kind: "research", nestingDepth: 1 }, []), { allowed: true, queued: false, needsConfirmation: false });
  assert.equal(evaluateAgentViewLaunchPolicy(config, { write: true, scope: "project", kind: "implementation", nestingDepth: 1 }, []).needsConfirmation, true);
  assert.equal(evaluateAgentViewLaunchPolicy(config, { write: true, scope: "project", kind: "implementation", nestingDepth: 1, confirmed: true }, []).allowed, true);
  assert.equal(evaluateAgentViewLaunchPolicy(config, { write: true, scope: "user", kind: "implementation", nestingDepth: 1, confirmed: true }, []).allowed, false);
  assert.equal(evaluateAgentViewLaunchPolicy(config, { write: false, scope: "project", kind: "research", nestingDepth: 2 }, []).allowed, false);

  const active = [{ status: "running", write: false }, { status: "running", write: true }] as any[];
  assert.equal(evaluateAgentViewLaunchPolicy(config, { write: false, scope: "project", kind: "research", nestingDepth: 1 }, active).queued, true);
  assert.equal(evaluateAgentViewLaunchPolicy(config, { write: true, scope: "project", kind: "implementation", nestingDepth: 1, confirmed: true }, active).queued, true);

  const trusted = validatePantheonConfig({ agentView: { policy: { requireWriteConfirmation: false } } }).config;
  assert.equal(evaluateAgentViewLaunchPolicy(trusted, { write: true, scope: "project", kind: "implementation", nestingDepth: 1 }, []).needsConfirmation, false);

  assert.equal(markAgentViewRunStale({ status: "running", write: false } as any, config).autoRespawn, true);
  assert.equal(markAgentViewRunStale({ status: "running", write: true } as any, config).needsConfirmation, true);
});

test("write-capable Runs prepare sibling worktrees, warn outside git, detect diffs, apply with confirmation, and cleanup empty worktrees", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-worktree-"));
  const gitProject = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(gitProject, ".git"), { recursive: true });
  const config = validatePantheonConfig({}).config;
  const run = { runId: "run_123", specialist: "fixer", task: "Change README!", write: true, artifacts: [] } as any;

  const worktree = prepareAgentViewWorktree(gitProject, config, run, { confirmed: true });
  assert.equal(worktree.inPlaceWarning, undefined);
  assert.match(worktree.branchName, /^agent-view\/fixer\/change-readme\/run-123/);
  assert.equal(path.dirname(worktree.path), tempRoot);

  fs.mkdirSync(worktree.path, { recursive: true });
  fs.writeFileSync(path.join(worktree.path, "README.md"), "changed");
  const diff = detectAgentViewDiff({ ...run, worktree });
  assert.match(diff.text, /README.md/);
  assert.equal(diff.source, "tool-events");

  const rejected = applyAgentViewChanges({ ...run, worktree }, { patch: "diff --git a/README.md b/README.md", confirmed: false, mode: "patch" });
  assert.equal(rejected.applied, false);
  assert.match(rejected.diagnostic, /confirmation/i);
  const applied = applyAgentViewChanges({ ...run, worktree }, { patch: "diff --git a/README.md b/README.md", confirmed: true, mode: "patch" });
  assert.equal(applied.applied, true);

  const nongit = prepareAgentViewWorktree(path.join(tempRoot, "plain"), config, run, { confirmed: true });
  assert.match(nongit.inPlaceWarning ?? "", /Non-git project/);

  const emptyWorktree = { ...worktree, path: path.join(tempRoot, "empty-worktree") };
  fs.mkdirSync(emptyWorktree.path, { recursive: true });
  assert.equal(cleanupAgentViewWorktree({ ...run, worktree: emptyWorktree }).removed, true);
  assert.equal(fs.existsSync(emptyWorktree.path), false);
});

test("Attempts, fallback, stop/delete, and retention preserve important Runs and prune completed read-only Runs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-retention-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({ agentView: { storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user") }, supervisor: { socketDir: path.join(tempRoot, "sockets") } } }).config;

  const fallback = recordAgentViewFallbackAttempts("run_fallback", ["bad-model", "good-model"], (model) => model === "good-model");
  assert.deepEqual(fallback.attempts.map((attempt) => attempt.status), ["failed", "completed"]);
  assert.equal(fallback.status, "completed");

  const stopped = createNoopAgentViewRun(projectDir, config, { task: "stop me" });
  const stoppedRun = stopAgentViewRun(projectDir, config, stopped.runId)!;
  assert.equal(stoppedRun.status, "stopped");
  assert.ok(fs.existsSync(stoppedRun.eventLogPath));

  const removable = createNoopAgentViewRun(projectDir, config, { task: "delete me" });
  const artifactPath = removable.artifacts[0]!.path;
  const removed = deleteAgentViewRun(projectDir, config, removable.runId, { retain: false, confirmed: true });
  assert.equal(removed?.deleted, true);
  assert.equal(readAgentViewRun(projectDir, config, removable.runId, { includeDeleted: true }), undefined);
  assert.equal(fs.existsSync(artifactPath), false);

  const completedA = launchReadOnlyForTest(projectDir, config, "completed A");
  const completedB = launchReadOnlyForTest(projectDir, config, "completed B");
  const writeRun = createNoopAgentViewRun(projectDir, config, { task: "keep write", write: true });
  const failedRun = createNoopAgentViewRun(projectDir, config, { task: "keep failed" });
  failedRun.status = "failed";
  const staleRun = createNoopAgentViewRun(projectDir, config, { task: "keep stale" });
  staleRun.status = "stale";

  const pruned = pruneAgentViewRuns(projectDir, config, { maxCompletedReadOnly: 1, extraRuns: [failedRun, staleRun] });
  assert.equal(pruned.prunedRunIds.length, 1);
  assert.ok(pruned.prunedRunIds.includes(completedA.runId) || pruned.prunedRunIds.includes(completedB.runId));
  assert.ok(!pruned.prunedRunIds.includes(writeRun.runId));
  assert.ok(!pruned.prunedRunIds.includes(failedRun.runId));
  assert.ok(!pruned.prunedRunIds.includes(staleRun.runId));
});

test("Agent View summaries use dedicated summary model, refresh on transitions, throttle running updates, and persist cache", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-summary-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({
    agentView: {
      storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user") },
      supervisor: { socketDir: path.join(tempRoot, "sockets") },
      summary: { model: "openai/summary", runningThrottleMs: 1000 },
    },
  }).config;
  const run = createNoopAgentViewRun(projectDir, config, { task: "summarize me" });
  let calls = 0;
  const first = refreshAgentViewSummary(projectDir, config, run, { nowMs: 1000, modelCall: ({ model }) => { calls += 1; return `summary via ${model}`; } });
  assert.equal(first.summary, "summary via openai/summary");
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(first.cachePath));

  const throttled = refreshAgentViewSummary(projectDir, config, { ...run, status: "running" }, { nowMs: 1200, modelCall: () => { calls += 1; return "too soon"; } });
  assert.equal(throttled.summary, first.summary);
  assert.equal(calls, 1);

  const transition = refreshAgentViewSummary(projectDir, config, { ...run, status: "completed" }, { nowMs: 1300, previousStatus: "running", modelCall: () => { calls += 1; return "completed summary"; } });
  assert.equal(transition.summary, "completed summary");
  assert.equal(calls, 2);

  const cached = refreshAgentViewSummary(projectDir, config, { ...run, status: "completed" }, { nowMs: 1400, modelCall: () => { calls += 1; return "unneeded"; } });
  assert.equal(cached.summary, "completed summary");
  assert.equal(calls, 2);
});

test("Run Groups launch parallel and chain Runs with dependencies and previous expansion", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-group-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({ agentView: { storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user") }, supervisor: { socketDir: path.join(tempRoot, "sockets") } } }).config;

  const parallel = launchAgentViewRunGroup(projectDir, config, { mode: "parallel", runs: [{ task: "map", specialist: "explorer" }, { task: "review", specialist: "oracle" }] });
  assert.equal(parallel.kind, "parallel");
  assert.equal(parallel.runs.length, 2);
  assert.deepEqual(parallel.dependencies, []);

  const chain = launchAgentViewRunGroup(projectDir, config, { mode: "chain", runs: [{ task: "first answer", specialist: "explorer" }, { task: "use {previous}", specialist: "fixer" }] });
  assert.equal(chain.kind, "chain");
  assert.equal(chain.runs.length, 2);
  assert.match(chain.runs[1]!.task, /first answer/);
  assert.deepEqual(chain.dependencies, [{ fromRunId: chain.runs[0]!.runId, toRunId: chain.runs[1]!.runId }]);
});

test("Council presets launch as Run Groups with parallel councillors and synthesis dependencies", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-council-"));
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const config = validatePantheonConfig({ agentView: { storage: { projectArtifactDir: path.join(projectDir, ".agent-view"), userArtifactDir: path.join(tempRoot, "user") }, supervisor: { socketDir: path.join(tempRoot, "sockets") } } }).config;

  const council = launchAgentViewCouncilGroup(projectDir, config, { prompt: "decide", preset: "review-board", councillors: ["reviewer", "architect"], master: "council-master" });
  assert.equal(council.kind, "council");
  assert.equal(council.councillorRuns.length, 2);
  assert.equal(council.synthesisRun.specialist, "council-master");
  assert.match(council.synthesisRun.task, /reviewer/);
  assert.match(council.synthesisRun.task, /architect/);
  assert.deepEqual(council.dependencies, council.councillorRuns.map((run) => ({ fromRunId: run.runId, toRunId: council.synthesisRun.runId })));
});

test("global Agent View registers projects, routes launches, and groups Runs by project", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-view-global-"));
  const projectA = path.join(tempRoot, "alpha");
  const projectB = path.join(tempRoot, "beta");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  const config = validatePantheonConfig({ agentView: { storage: { projectArtifactDir: ".agent-view", userArtifactDir: path.join(tempRoot, "user") }, supervisor: { socketDir: path.join(tempRoot, "sockets") } } }).config;

  const a = registerAgentViewProject(projectA, config);
  const b = registerAgentViewProject(projectB, config);
  assert.equal(a.displayName, "alpha");
  assert.ok(a.projectId);
  assert.ok(a.lastSeenAt);

  launchReadOnlyAgentViewRun(projectA, config, { task: "A run" });
  launchReadOnlyAgentViewRun(projectB, config, { task: "B run" });

  assert.equal(resolveAgentViewProjectLaunch(config, a.projectId)?.cwd, projectA);
  assert.equal(resolveAgentViewProjectLaunch(config, b.projectId)?.cwd, projectB);

  const grouped = groupGlobalAgentViewRunsByProject(config);
  assert.equal(grouped.find((group) => group.project.projectId === a.projectId)?.runs.length, 1);
  assert.equal(grouped.find((group) => group.project.projectId === b.projectId)?.runs.length, 1);
});

test("Agent View UI groups Runs, resolves shorthand to Specialist first, displays target, and gates write shorthand", () => {
  const runs = [
    { runId: "r1", status: "needs_input", specialist: "fixer", task: "fix", project: { displayName: "alpha" }, write: true },
    { runId: "r2", status: "completed", specialist: "explorer", task: "map", project: { displayName: "beta" }, write: false },
  ] as any[];
  assert.equal(groupAgentViewRunsForUi(runs).at(0)?.group, "Action needed");
  assert.equal(groupAgentViewRunsForUi(runs, "project").find((group) => group.group === "alpha")?.runs.length, 1);
  assert.equal(groupAgentViewRunsForUi(runs, "specialist").find((group) => group.group === "fixer")?.runs.length, 1);

  const shorthand = resolveAgentViewShorthandDispatch("fixer repair bug", { specialists: ["fixer"], projects: [{ displayName: "fixer", projectId: "project-1" }] });
  assert.equal(shorthand.targetType, "specialist");
  assert.match(shorthand.display, /Specialist fixer/);

  const writeConfig = validatePantheonConfig({ agentView: { policy: { requireWriteConfirmation: true } } }).config;
  const gated = resolveAgentViewShorthandDispatch("fixer write patch", { specialists: ["fixer"], projects: [], config: writeConfig, write: true });
  assert.equal(gated.needsConfirmation, true);
  const trusted = validatePantheonConfig({ agentView: { policy: { requireWriteConfirmation: false } } }).config;
  const ungated = resolveAgentViewShorthandDispatch("fixer write patch", { specialists: ["fixer"], projects: [], config: trusted, write: true });
  assert.equal(ungated.needsConfirmation, false);
});

function launchReadOnlyForTest(projectDir: string, config: ReturnType<typeof validatePantheonConfig>["config"], task: string) {
  return launchReadOnlyAgentViewRun(projectDir, config, { task });
}
