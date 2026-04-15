import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/oh-my-opencode-pi/index.ts";
import {
  enqueueBackgroundSpec,
  listBackgroundTasks,
  renderBackgroundResult,
  retryBackgroundTask,
} from "../extensions/oh-my-opencode-pi/background.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export interface OrchestrationScenarioDefinition {
  id: string;
  title: string;
  workflow: string;
  description: string;
  tags: string[];
  baseline: {
    label: string;
    status: "passed" | "failed";
    durationMs: number;
    attempts: number;
    qualityScore: number;
    notes: string[];
  };
}

export interface OrchestrationScenarioActualResult {
  scenarioId: string;
  title: string;
  workflow: string;
  passed: boolean;
  durationMs: number;
  attempts: number;
  qualityScore: number;
  timeline: string;
  outputPreview: string;
  fallbackRecovered?: boolean;
  routingMatched?: boolean;
  notes: string[];
}

export interface OrchestrationBenchmarkResult {
  scenario: OrchestrationScenarioDefinition;
  actual: OrchestrationScenarioActualResult;
  comparison: "orchestration" | "baseline" | "tie";
  reasons: string[];
}

function fakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function registerHarness(commandMessages: Array<{ content?: string; details?: any }> = []) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const fakePi = {
    on() {},
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, spec: any) {
      commands.set(name, spec);
    },
    registerMessageRenderer() {},
    sendMessage(message: { content?: string; details?: any }) {
      commandMessages.push(message);
    },
    sendUserMessage() {},
    appendEntry() {},
  };
  extension(fakePi as never);
  return { tools, commands };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for eval predicate");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function previewText(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withProcessArgv1<T>(scriptPath: string, fn: () => Promise<T>): Promise<T> {
  const original = process.argv[1];
  process.argv[1] = scriptPath;
  try {
    return await fn();
  } finally {
    process.argv[1] = original;
  }
}

async function withAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
}

export function loadScenarioDefinitions(rootDir = path.join(process.cwd(), "evals", "scenarios")): OrchestrationScenarioDefinition[] {
  return fs.readdirSync(rootDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(rootDir, file), "utf8")) as OrchestrationScenarioDefinition)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function runDelegateFallbackRecovery(def: OrchestrationScenarioDefinition): Promise<OrchestrationScenarioActualResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-eval-delegate-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.jsonc"), `{
    "agents": {
      "fixer": { "model": "demo/primary" }
    },
    "fallback": {
      "retryOnEmpty": true,
      "agentChains": { "fixer": ["demo/backup"] }
    }
  }`);

  const fakePi = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePi, `
    const args = process.argv.slice(2);
    const modelIndex = args.indexOf("--model");
    const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
    const task = args[args.length - 1] || "";
    const text = model === "demo/primary" ? "" : "recovered:" + task.slice(0, 40);
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        model,
        stopReason: "end_turn"
      }
    }));
  `);

  return withAgentDir(agentDir, () => withProcessArgv1(fakePi, async () => {
    const { tools } = registerHarness();
    const delegateTool = tools.get("pantheon_delegate");
    const updates: string[] = [];
    const startedAt = Date.now();
    const result = await delegateTool.execute(
      "eval-delegate-fallback",
      { agent: "fixer", task: "Recover this task" },
      undefined,
      (partial: any) => updates.push(partial.content?.[0]?.text ?? "(no partial)"),
      {
        cwd: projectDir,
        ui: {
          theme: fakeTheme(),
          setWidget() {},
          setEditorText() {},
          notify() {},
          setStatus() {},
        },
      },
    );
    const details = result.details?.results?.[0];
    const finalText = result.content?.[0]?.text ?? "";
    const passed = result.isError !== true && /recovered:/i.test(finalText) && details?.model === "demo/backup";
    return {
      scenarioId: def.id,
      title: def.title,
      workflow: def.workflow,
      passed,
      durationMs: Math.max(1, Date.now() - startedAt),
      attempts: details?.model === "demo/backup" ? 2 : 1,
      qualityScore: passed ? 1 : 0,
      timeline: [
        `Scenario: ${def.id}`,
        "Updates:",
        ...(updates.length > 0 ? updates.map((item) => `- ${previewText(item)}`) : ["- (none)"]),
        "Final:",
        `- ${previewText(finalText)}`,
        `- model: ${details?.model ?? "unknown"}`,
      ].join("\n"),
      outputPreview: previewText(finalText),
      fallbackRecovered: details?.model === "demo/backup",
      notes: [
        details?.model === "demo/backup" ? "Recovered via fallback backup model." : "Did not switch to backup model.",
      ],
    };
  }));
}

async function runCouncilSynthesisProgress(def: OrchestrationScenarioDefinition): Promise<OrchestrationScenarioActualResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-eval-council-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const fakePi = path.join(tempRoot, "fake-pi.mjs");
  fs.writeFileSync(fakePi, `
    const task = process.argv[process.argv.length - 1] || "";
    const isMaster = task.includes("Original question:");
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: isMaster ? "master-synthesis: proceed with guardrails" : "councillor-view: consider trade-offs" }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  return withAgentDir(agentDir, () => withProcessArgv1(fakePi, async () => {
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const { commands } = registerHarness(commandMessages);
    const command = commands.get("pantheon-council");
    const editorWrites: string[] = [];
    const widgetWrites: string[][] = [];
    const startedAt = Date.now();
    await command.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        custom: async () => "default",
        input: async () => "Should we proceed?",
        notify() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        setStatus() {},
        setWidget(_key: string, lines?: string[]) {
          if (Array.isArray(lines)) widgetWrites.push(lines);
        },
      },
    });
    const finalText = commandMessages.at(-1)?.content ?? "";
    const partialCount = widgetWrites.filter((lines) => /… running/i.test(lines.join("\n"))).length;
    const passed = editorWrites.length === 1 && partialCount > 0 && /Status: success/i.test(finalText) && /Council preset: default/i.test(finalText);
    const normalizeCouncilWidgetLine = (line: string): string => {
      const normalized = line.replace(/\(\d+ms\)/g, "(<elapsed>)");
      if (normalized.includes("· councillors |")) {
        const ready = (normalized.match(/✓ /g) ?? []).length;
        return `Pantheon subagents • council default · councillors | ${ready}/3 ready`;
      }
      if (normalized.startsWith("Pantheon subagents • council default |") && normalized.includes("✓ ")) {
        const finished = (normalized.match(/✓ /g) ?? []).length;
        return `Pantheon subagents • council default | ${finished}/4 finished`;
      }
      return normalized;
    };

    return {
      scenarioId: def.id,
      title: def.title,
      workflow: def.workflow,
      passed,
      durationMs: Math.max(1, Date.now() - startedAt),
      attempts: 4,
      qualityScore: passed ? 1 : 0.3,
      timeline: [
        `Scenario: ${def.id}`,
        `Editor writes: ${editorWrites.length}`,
        "Chat final:",
        previewText(finalText, 180),
        "Widget updates:",
        ...widgetWrites.map((lines, index) => `${index + 1}. ${previewText(normalizeCouncilWidgetLine(lines.join(" | ")), 180)}`),
      ].join("\n"),
      outputPreview: previewText(finalText),
      notes: [
        partialCount > 0 ? `Observed ${partialCount} partial widget update(s).` : "No partial council progress observed.",
      ],
    };
  }));
}

async function runBackgroundRetryRecovery(def: OrchestrationScenarioDefinition): Promise<OrchestrationScenarioActualResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-eval-background-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  const taskDir = path.join(tempRoot, "tasks");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.json"), JSON.stringify({
    background: { enabled: true, logDir: taskDir, maxConcurrent: 1, reuseSessions: false, heartbeatIntervalMs: 100, staleAfterMs: 5000 },
    workflow: { persistTodos: false },
  }, null, 2));

  const stateFile = path.join(tempRoot, "flaky-state.txt");
  const flakyPi = path.join(tempRoot, "flaky-pi.mjs");
  fs.writeFileSync(flakyPi, `
    import * as fs from "node:fs";
    const stateFile = ${JSON.stringify(stateFile)};
    const attempts = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, "utf8")) || 0 : 0;
    fs.writeFileSync(stateFile, String(attempts + 1));
    if (attempts === 0) {
      console.error("first attempt failed");
      process.exit(1);
    }
    console.log(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "background recovered" }],
        model: "fake/model",
        stopReason: "end_turn"
      }
    }));
  `);

  return withAgentDir(agentDir, async () => {
    const startedAt = Date.now();
    const first = enqueueBackgroundSpec(projectDir, {
      agent: "fixer",
      task: "Retry after failure",
      cwd: projectDir,
      piCommand: process.execPath,
      piBaseArgs: [flakyPi],
      retryOnEmpty: false,
    }, {
      taskDir,
      randomId: () => "bg_eval_first",
      maxConcurrent: 1,
    });
    await waitFor(() => listBackgroundTasks(taskDir).some((task) => task.id === first.id && task.status === "failed"));
    const failed = listBackgroundTasks(taskDir).find((task) => task.id === first.id)!;
    const retried = retryBackgroundTask(projectDir, failed, { taskDir, randomId: () => "bg_eval_retry" });
    if (!retried) throw new Error("Unable to retry background eval task");
    await waitFor(() => listBackgroundTasks(taskDir).some((task) => task.id === retried.id && task.status === "completed"));
    const completed = listBackgroundTasks(taskDir).find((task) => task.id === retried.id)!;
    const rendered = renderBackgroundResult(completed, { includeLogTail: true, logLines: 5, staleAfterMs: 5000 });
    const passed = failed.status === "failed" && completed.status === "completed" && /background recovered/i.test(rendered);
    return {
      scenarioId: def.id,
      title: def.title,
      workflow: def.workflow,
      passed,
      durationMs: Math.max(1, Date.now() - startedAt),
      attempts: 2,
      qualityScore: passed ? 1 : 0.2,
      timeline: [
        `Scenario: ${def.id}`,
        `Initial: ${failed.id} [${failed.status}] ${failed.summary ?? failed.task}`,
        `Retry: ${completed.id} [${completed.status}] ${completed.summary ?? completed.task}`,
        "Rendered result:",
        rendered,
      ].join("\n"),
      outputPreview: previewText(rendered),
      fallbackRecovered: true,
      notes: ["Background retry recovered after a preserved failed task artifact."],
    };
  });
}

async function runAdapterLocalDocsRouting(def: OrchestrationScenarioDefinition): Promise<OrchestrationScenarioActualResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-eval-adapter-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo\n\nInstallation: run npm install.\n");
  fs.writeFileSync(path.join(projectDir, "docs", "setup.md"), "Usage guide: installation steps and setup notes.\n");

  return withAgentDir(agentDir, async () => {
    const { tools } = registerHarness();
    const searchTool = tools.get("pantheon_adapter_search");
    const startedAt = Date.now();
    const result = await searchTool.execute("eval-adapter-local", { query: "installation guide" }, undefined, undefined, { cwd: projectDir });
    const text = result.content?.[0]?.text ?? "";
    const adapters = ((result.details?.adapters ?? []) as Array<{ adapter?: string }>).map((item) => item.adapter).filter(Boolean);
    const passed = /Selection:/i.test(text) && /local-docs/i.test(text) && /README\.md|docs\/setup\.md/i.test(text);
    return {
      scenarioId: def.id,
      title: def.title,
      workflow: def.workflow,
      passed,
      durationMs: Math.max(1, Date.now() - startedAt),
      attempts: Math.max(1, adapters.length),
      qualityScore: passed ? 1 : 0.2,
      timeline: [
        `Scenario: ${def.id}`,
        `Adapters: ${adapters.join(", ") || "(none)"}`,
        text,
      ].join("\n"),
      outputPreview: previewText(text),
      routingMatched: adapters[0] === "local-docs" || /local-first default for repo docs/i.test(text),
      notes: [
        adapters[0] ? `Top adapter: ${adapters[0]}` : "No adapter list returned.",
      ],
    };
  });
}

async function runDoctorConfigDiagnostics(def: OrchestrationScenarioDefinition): Promise<OrchestrationScenarioActualResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-eval-doctor-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc"), `{
    "$schema": "../missing-schema.json",
    "mystery": true,
    "multiplexer": { "layout": "zigzag" }
  }`);

  return withAgentDir(agentDir, async () => {
    const commandMessages: Array<{ content?: string; details?: any }> = [];
    const { commands } = registerHarness(commandMessages);
    const command = commands.get("pantheon-doctor");
    const editorWrites: string[] = [];
    const startedAt = Date.now();
    await command.handler("", {
      cwd: projectDir,
      hasUI: true,
      ui: {
        notify() {},
        setEditorText(text: string) {
          editorWrites.push(text);
        },
        setStatus() {},
        setWidget() {},
        input: async () => "",
        custom: async () => null,
      },
    });
    const finalText = editorWrites.at(-1) ?? commandMessages.at(-1)?.content ?? "";
    const normalizedText = finalText
      .replace(new RegExp(escapeRegExp(projectDir), "g"), "<PROJECT_DIR>")
      .replace(new RegExp(escapeRegExp(path.join(projectDir, ".pi", "oh-my-opencode-pi.jsonc")), "g"), "<PROJECT_CONFIG>")
      .replace(/Background task dir: (ready|missing) — .+/g, "Background task dir: $1 — <BACKGROUND_DIR>")
      .replace(/Debug dir: (ready|missing) — .+/g, "Debug dir: $1 — <DEBUG_DIR>")
      .replace(/Workflow state file: (present|not yet created) — .+/g, "Workflow state file: $1 — <WORKFLOW_STATE>")
      .replace(/tmux available: (yes|no)/g, "tmux available: <detected>")
      .replace(/inside tmux: (yes|no)/g, "inside tmux: <detected>");
    const passed = editorWrites.length === 1 && /Pantheon doctor report/i.test(normalizedText) && /Config diagnostics:/i.test(normalizedText) && /Suggested next steps:/i.test(normalizedText);
    return {
      scenarioId: def.id,
      title: def.title,
      workflow: def.workflow,
      passed,
      durationMs: Math.max(1, Date.now() - startedAt),
      attempts: 1,
      qualityScore: passed ? 1 : 0.25,
      timeline: [
        `Scenario: ${def.id}`,
        normalizedText,
      ].join("\n"),
      outputPreview: previewText(normalizedText),
      notes: [passed ? "Doctor surfaced categorized diagnostics and next steps." : "Doctor report missing expected guidance."],
    };
  });
}

export async function runOrchestrationScenario(def: OrchestrationScenarioDefinition): Promise<OrchestrationScenarioActualResult> {
  switch (def.id) {
    case "delegate-fallback-recovery":
      return runDelegateFallbackRecovery(def);
    case "council-synthesis-progress":
      return runCouncilSynthesisProgress(def);
    case "background-retry-recovery":
      return runBackgroundRetryRecovery(def);
    case "adapter-local-docs-routing":
      return runAdapterLocalDocsRouting(def);
    case "doctor-config-diagnostics":
      return runDoctorConfigDiagnostics(def);
    default:
      throw new Error(`No orchestration eval runner registered for scenario '${def.id}'.`);
  }
}

export function compareOrchestrationScenario(def: OrchestrationScenarioDefinition, actual: OrchestrationScenarioActualResult): OrchestrationBenchmarkResult {
  const reasons: string[] = [];
  let comparison: "orchestration" | "baseline" | "tie" = "tie";
  if (actual.passed && def.baseline.status === "failed") {
    comparison = "orchestration";
    reasons.push("Orchestrated workflow passed while the baseline is expected to fail.");
  } else if (!actual.passed && def.baseline.status === "passed") {
    comparison = "baseline";
    reasons.push("Orchestrated workflow failed while the baseline is expected to pass.");
  } else if (actual.qualityScore > def.baseline.qualityScore) {
    comparison = "orchestration";
    reasons.push(`Quality score improved from ${def.baseline.qualityScore} to ${actual.qualityScore}.`);
  } else if (actual.qualityScore < def.baseline.qualityScore) {
    comparison = "baseline";
    reasons.push(`Quality score regressed from ${def.baseline.qualityScore} to ${actual.qualityScore}.`);
  } else {
    reasons.push("Scores are effectively tied.");
  }
  if (actual.fallbackRecovered) reasons.push("Observed a successful orchestration recovery path.");
  if (actual.routingMatched === false) reasons.push("Routing mismatch detected in orchestration result.");
  return { scenario: def, actual, comparison, reasons };
}

export async function runOrchestrationScenarioCorpus(definitions = loadScenarioDefinitions()): Promise<OrchestrationBenchmarkResult[]> {
  const results: OrchestrationBenchmarkResult[] = [];
  for (const def of definitions) {
    const actual = await runOrchestrationScenario(def);
    results.push(compareOrchestrationScenario(def, actual));
  }
  return results;
}

export function renderOrchestrationBenchmarkReport(results: OrchestrationBenchmarkResult[]): string {
  const orchestrationWins = results.filter((result) => result.comparison === "orchestration").length;
  const baselineWins = results.filter((result) => result.comparison === "baseline").length;
  const ties = results.filter((result) => result.comparison === "tie").length;
  const passCount = results.filter((result) => result.actual.passed).length;
  return [
    `Scenarios: ${results.length}`,
    `Passed: ${passCount}/${results.length}`,
    `Benchmark outcomes: ${orchestrationWins} orchestration wins / ${baselineWins} baseline wins / ${ties} ties`,
    "",
    ...results.flatMap((result) => [
      `${result.scenario.id} — ${result.actual.passed ? "passed" : "failed"} — compare:${result.comparison}`,
      `  workflow: ${result.scenario.workflow}`,
      `  duration: ${result.actual.durationMs}ms • attempts: ${result.actual.attempts} • quality: ${result.actual.qualityScore}`,
      `  baseline: ${result.scenario.baseline.label} [${result.scenario.baseline.status}] ${result.scenario.baseline.durationMs}ms • quality ${result.scenario.baseline.qualityScore}`,
      ...result.reasons.map((reason) => `  reason: ${reason}`),
      `  output: ${result.actual.outputPreview}`,
      "",
    ]),
  ].join("\n");
}

export function benchmarkResultsToJson(results: OrchestrationBenchmarkResult[]) {
  return {
    scenarios: results.map((result) => ({
      id: result.scenario.id,
      title: result.scenario.title,
      workflow: result.scenario.workflow,
      passed: result.actual.passed,
      comparison: result.comparison,
      durationMs: result.actual.durationMs,
      attempts: result.actual.attempts,
      qualityScore: result.actual.qualityScore,
      fallbackRecovered: result.actual.fallbackRecovered ?? false,
      routingMatched: result.actual.routingMatched ?? true,
      reasons: result.reasons,
    })),
  };
}
