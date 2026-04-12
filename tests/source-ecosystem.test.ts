import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, { selectAdapterIds, summarizeAdapterSearchSections } from "../extensions/oh-my-opencode-pi/index.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("adapter auto-selection prefers local docs for repo docs queries and exposes adapter health", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-sources-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "README.md"), "# Demo\n\nInstallation: run npm install.\n");
  fs.writeFileSync(path.join(projectDir, "docs", "setup.md"), "Usage guide: installation steps and setup notes.\n");

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const tools = new Map<string, any>();
    const fakePi = {
      on() {},
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      sendUserMessage() {},
      appendEntry() {},
    };
    extension(fakePi as never);

    const searchTool = tools.get("pantheon_adapter_search");
    const result = await searchTool.execute("call-1", { query: "installation guide" }, undefined, undefined, { cwd: projectDir });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Selection:/);
    assert.match(text, /Summary:/);
    assert.match(text, /local-docs/);
    assert.match(text, /repo-local docs keywords|local-first default for repo docs/);
    assert.match(text, /README\.md|docs\/setup\.md/);

    const listTool = tools.get("pantheon_adapter_list");
    const listResult = await listTool.execute("call-2", {}, undefined, undefined, { cwd: projectDir });
    const listText = listResult.content[0]?.text ?? "";
    assert.match(listText, /github-code-search/);
    assert.match(listText, /local-docs/);
    assert.match(listText, /npm-registry/);

    const healthTool = tools.get("pantheon_adapter_health");
    const healthResult = await healthTool.execute("call-3", {}, undefined, undefined, { cwd: projectDir });
    const healthText = healthResult.content[0]?.text ?? "";
    assert.match(healthText, /local-docs/);
    assert.match(healthText, /github-code-search/);
    assert.match(healthText, /auth=/);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});

test("adapter selection ranking and fusion helpers prefer package and repo-aware sources", () => {
  const rankedPackage = selectAdapterIds({ adapters: {} } as never, "auto", { package: "typescript", query: "package docs and installation" });
  assert.equal(rankedPackage[0], "npm-registry");
  assert.ok(rankedPackage.includes("docs-context7"));

  const rankedRepo = selectAdapterIds({ adapters: {} } as never, "auto", { repo: "owner/repo", query: "implementation example" });
  assert.equal(rankedRepo[0], "github-code-search");
  assert.ok(rankedRepo.includes("grep-app"));

  const rankedWithToken = selectAdapterIds({ research: { githubToken: "ghp_demo" }, adapters: {} } as never, "auto", { repo: "owner/repo", query: "release notes and changelog" });
  assert.equal(rankedWithToken[0], "github-releases");
  assert.ok(rankedWithToken.includes("github-code-search"));

  const summary = summarizeAdapterSearchSections([
    { adapter: "local-docs", text: "Adapter: local-docs\nQuery: installation\n\n1. README.md\n   Run npm install" },
    { adapter: "docs-context7", text: "Adapter: docs-context7\nPackage: demo\n\n1. Installation\n   https://example.com/install" },
    { adapter: "local-docs", text: "Adapter: local-docs\nQuery: installation\n\n1. README.md\n   Run npm install" },
  ]);
  assert.match(summary, /Summary:/);
  assert.match(summary, /local-docs/);
  assert.match(summary, /docs-context7/);
  assert.match(summary, /Run npm install/);
});
