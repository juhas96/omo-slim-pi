import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

test("extension registers delegate, council, and background tools", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const handlers: string[] = [];

  const fakePi = {
    on(event: string) {
      handlers.push(event);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    sendUserMessage() {
      // noop
    },
  };

  extension(fakePi as never);

  assert.ok(tools.includes("pantheon_delegate"));
  assert.ok(tools.includes("pantheon_council"));
  assert.ok(tools.includes("pantheon_background"));
  assert.ok(tools.includes("pantheon_lsp_goto_definition"));
  assert.ok(tools.includes("pantheon_lsp_hover"));
  assert.ok(tools.includes("pantheon_lsp_symbols"));
  assert.ok(tools.includes("pantheon_apply_patch"));
  assert.ok(tools.includes("pantheon_ast_grep_search"));
  assert.ok(tools.includes("pantheon_repo_map"));
  assert.ok(tools.includes("pantheon_code_map"));
  assert.ok(tools.includes("pantheon_runtime_info"));
  assert.ok(tools.includes("pantheon_stats"));
  assert.ok(tools.includes("pantheon_spec_template"));
  assert.ok(tools.includes("pantheon_bootstrap"));
  assert.ok(tools.includes("pantheon_adapter_search"));
  assert.ok(tools.includes("pantheon_adapter_fetch"));
  assert.ok(commands.includes("pantheon"));
  assert.ok(commands.includes("pantheon-config"));
  assert.ok(commands.includes("pantheon-skills"));
  assert.ok(commands.includes("pantheon-code-map"));
  assert.ok(commands.includes("pantheon-runtime"));
  assert.ok(commands.includes("pantheon-stats"));
  assert.ok(commands.includes("pantheon-spec-studio"));
  assert.ok(commands.includes("pantheon-bootstrap"));
  assert.ok(commands.includes("pantheon-adapters"));
  assert.ok(handlers.includes("before_agent_start"));
  assert.ok(handlers.includes("tool_result"));
});
