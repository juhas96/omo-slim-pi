import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverPantheonAgents } from "../extensions/oh-my-opencode-pi/agents.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

test("discoverPantheonAgents appends bundled skill guidance based on effective skill policy", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-agent-skills-"));
  const agentDir = path.join(tempRoot, "agent");
  const projectDir = path.join(tempRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

  fs.writeFileSync(path.join(agentDir, "oh-my-opencode-pi.jsonc"), `{
    "skills": {
      "defaultAllow": ["karpathy-guidelines"]
    },
    "agents": {
      "explorer": {
        "allowSkills": ["cartography"]
      },
      "fixer": {
        "denySkills": ["karpathy-guidelines"]
      }
    }
  }`);

  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    const { agents } = discoverPantheonAgents(projectDir, false);
    const explorer = agents.find((agent) => agent.name === "explorer");
    const fixer = agents.find((agent) => agent.name === "fixer");

    assert.ok(explorer);
    assert.ok(fixer);
    assert.match(explorer.systemPrompt, /Prefer the bundled karpathy-guidelines skill/i);
    assert.match(explorer.systemPrompt, /Prefer the bundled cartography skill/i);
    assert.match(explorer.systemPrompt, /Allowed skills: karpathy-guidelines, cartography\./i);

    assert.match(fixer.systemPrompt, /Disallowed skills: karpathy-guidelines\./i);
    assert.doesNotMatch(fixer.systemPrompt, /Prefer the bundled karpathy-guidelines skill/i);
  } finally {
    if (previous === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = previous;
  }
});
