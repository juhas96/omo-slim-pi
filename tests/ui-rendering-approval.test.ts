import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderBackgroundResult, renderBackgroundWatch } from "../extensions/oh-my-opencode-pi/background.ts";
import { buildConfigReport, buildAdapterPolicyReport, buildDoctorReport } from "../extensions/oh-my-opencode-pi/reports.ts";
import { buildPantheonCommandOutputLines, buildPantheonDashboardLines, buildPantheonReportModalLines, buildPantheonSelectChromeLines, buildPantheonSubagentInspectorLines } from "../extensions/oh-my-opencode-pi/ui.ts";

function fixture(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", name), "utf8");
}

function fakeCtx() {
  return {
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    },
  } as any;
}

test("Pantheon UI renderers match approval fixtures", () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const ctx = fakeCtx();
    const commandOutput = buildPantheonCommandOutputLines(ctx, "/pantheon-hooks", "Pantheon hook trace report\nAll systems nominal.", {
      status: "success",
      summary: "Hook trace report",
    }).join("\n");
    assert.equal(commandOutput, fixture("command-output-widget.txt"));

    const selectChrome = buildPantheonSelectChromeLines({
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    }, "Council preset", "↑↓ navigate • enter select • esc cancel").join("\n");
    assert.equal(selectChrome, fixture("select-overlay-chrome.txt"));

    const reportModal = buildPantheonReportModalLines({
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    }, "Config report", "Config report with 2 warnings", "Pantheon config report\n\nLine A\nLine B", "Enter or Esc closes this modal. Full report stays in the editor.").join("\n");
    assert.equal(reportModal, fixture("report-overlay-chrome.txt"));

    const scrollableReportModal = buildPantheonReportModalLines({
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    }, "Config report", "Long config report", Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join("\n"), "↑↓ / j k / Home End scroll • Enter or Esc close • Full report stays in the editor.", 5, 8).join("\n");
    assert.equal(scrollableReportModal, fixture("report-overlay-scroll.txt"));

    const dashboard = buildPantheonDashboardLines(
      ctx,
      { ui: { maxTodos: 2, maxBackgroundTasks: 2 } },
      { updatedAt: 1_700_000_000_000, uncheckedTodos: ["First todo item", "Second todo item", "Third todo item"] },
      [
        { id: "bg-1", agent: "fixer", task: "Implement thing", status: "running", createdAt: 1_699_999_990_000, startedAt: 1_699_999_995_000, logPath: "a", resultPath: "a" },
        { id: "bg-2", agent: "explorer", task: "Map repo structure", status: "queued", createdAt: 1_699_999_980_000, logPath: "b", resultPath: "b" },
        { id: "bg-3", agent: "librarian", task: "Read docs", status: "failed", createdAt: 1_699_999_970_000, logPath: "c", resultPath: "c" },
      ],
      true,
      2,
    ).join("\n");
    assert.equal(dashboard, fixture("dashboard-widget.txt"));

    const subagentInspector = buildPantheonSubagentInspectorLines({
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => `**${text}**`,
    }, {
      title: "Pantheon subagents",
      subtitle: "delegate parallel (1/2 done)",
      entries: [
        {
          label: "explorer",
          description: "Mapped entrypoints and import graph (1.2s)",
          expandedLines: [
            "task: Analyze the repo",
            "status: completed • 1.2s",
            "summary: Mapped entrypoints and import graph",
            "stdout: Found index.ts and ui.ts",
          ],
          traceAvailable: true,
        },
        {
          label: "librarian",
          description: "Reading docs… (0.6s)",
          expandedLines: [
            "task: Research the package",
            "status: running • 0.6s",
            "summary: waiting for output…",
          ],
        },
      ],
    }, [0], 0, "↑↓ move • Enter expand • Esc close", 10).join("\n");
    assert.equal(subagentInspector, fixture("subagent-inspector.txt"));

    const task = {
      id: "bg-42",
      agent: "fixer",
      task: "Patch the thing",
      status: "failed",
      createdAt: 1_699_999_900_000,
      startedAt: 1_699_999_940_000,
      finishedAt: 1_699_999_970_000,
      summary: "Patch failed after validation",
      sessionKey: "fixer:abc123",
      watchCount: 3,
      heartbeatAt: 1_699_999_998_000,
      logPath: path.join(process.cwd(), "tests", "fixtures", "background.log"),
      resultPath: path.join(process.cwd(), "tests", "fixtures", "bg-42.result.json"),
      result: {
        agent: "fixer",
        agentSource: "bundled",
        task: "Patch the thing",
        exitCode: 1,
        messages: [{ role: "assistant", content: [{ type: "text", text: "Patch failed on verification" }] }],
        stderr: "boom",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        durationMs: 30000,
      },
    } as any;
    assert.equal(renderBackgroundWatch(task, 5, 5_000), fixture("background-watch.txt"));
    assert.equal(renderBackgroundResult(task, { includeLogTail: true, logLines: 5, staleAfterMs: 5_000 }), fixture("background-result.txt"));

    const configReport = buildConfigReport({
      config: {
        ui: { dashboardWidget: true },
        workflow: { injectHints: true, persistTodos: true },
        autoContinue: { enabled: false, maxContinuations: 5 },
        background: { enabled: true, maxConcurrent: 2, reuseSessions: true, heartbeatIntervalMs: 1500, staleAfterMs: 20000 },
        multiplexer: { tmux: false, projectScopedWindow: true },
        skills: { defaultAllow: ["cartography"], defaultDeny: [], cartography: { enabled: true } },
        adapters: { defaultAllow: ["docs-context7"], defaultDeny: ["github-releases"], disabled: ["grep-app"] },
        agents: { fixer: {}, explorer: {} },
        council: { presets: { default: { councillors: [{ name: "alpha" }] } } },
      },
      warnings: ["Config parse warning in /tmp/demo.jsonc: 1 JSONC parse issue detected."],
      diagnostics: [{ severity: "warning", path: "config.mystery", message: "Unknown config key; it will be ignored by Pantheon.", source: "/tmp/demo.jsonc" }],
      sources: { globalPath: "/tmp/global.jsonc", projectPath: "/tmp/project/.pi/oh-my-opencode-pi.jsonc" },
      activePresets: ["durable"],
      availablePresets: ["default", "durable", "fast", "research"],
    });
    assert.equal(configReport, fixture("config-report.txt"));

    const adapterPolicy = buildAdapterPolicyReport({
      agentName: "interactive",
      adapters: [{ id: "docs-context7", description: "Docs adapter" }],
      registered: [
        { id: "docs-context7", description: "Docs adapter" },
        { id: "web-search", description: "Web adapter" },
      ],
      loadErrors: ["Failed to load custom adapter from /tmp/bad.mjs"],
    });
    assert.equal(adapterPolicy, fixture("adapter-policy-report.txt"));

    const doctorReport = buildDoctorReport({
      cwd: "/tmp/project",
      config: {
        config: {},
        warnings: [],
        diagnostics: [
          { severity: "error", path: "config.multiplexer.layout", message: "Expected one of: tiled, even-horizontal, even-vertical, main-horizontal, main-vertical.", source: "/tmp/project/.pi/oh-my-opencode-pi.jsonc" },
          { severity: "warning", path: "config.mystery", message: "Unknown config key; it will be ignored by Pantheon.", source: "/tmp/project/.pi/oh-my-opencode-pi.jsonc" },
        ],
        sources: { globalPath: "/tmp/global.jsonc", projectPath: "/tmp/project/.pi/oh-my-opencode-pi.jsonc" },
        activePresets: [],
        availablePresets: ["default"],
      },
      adapterHealth: [
        { id: "docs-context7", status: "ok", auth: "not-required", summary: "Docs source is ready." },
        { id: "github-releases", status: "warn", auth: "missing", summary: "GitHub token not configured; release lookup may be rate-limited." },
      ],
      tmuxAvailable: false,
      inTmux: false,
      backgroundDir: "/tmp/project/.oh-my-opencode-pi-tasks",
      backgroundDirExists: false,
      debugDir: "/tmp/project/.oh-my-opencode-pi-debug",
      debugDirExists: true,
      workflowStatePath: "/tmp/project/.oh-my-opencode-pi-workflow.json",
      workflowStateExists: false,
      taskCount: 2,
    });
    assert.equal(doctorReport, fixture("doctor-report.txt"));
  } finally {
    Date.now = realNow;
  }
});
