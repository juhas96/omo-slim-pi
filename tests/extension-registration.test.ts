import test from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/oh-my-opencode-pi/index.ts";

test("extension registers delegate, council, background, orchestration, and adapter tools", () => {
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
    registerMessageRenderer() {
      // noop
    },
    sendMessage() {
      // noop
    },
    sendUserMessage() {
      // noop
    },
    appendEntry() {
      // noop
    },
  };

  extension(fakePi as never);

  assert.ok(tools.includes("pantheon_delegate"));
  assert.ok(tools.includes("pantheon_council"));
  assert.ok(tools.includes("pantheon_background"));
  assert.ok(tools.includes("pantheon_background_watch"));
  assert.ok(tools.includes("pantheon_lsp_goto_definition"));
  assert.ok(tools.includes("pantheon_lsp_hover"));
  assert.ok(tools.includes("pantheon_lsp_symbols"));
  assert.ok(tools.includes("pantheon_lsp_organize_imports"));
  assert.ok(tools.includes("pantheon_format_document"));
  assert.ok(tools.includes("pantheon_apply_patch"));
  assert.ok(tools.includes("pantheon_ast_grep_search"));
  assert.ok(tools.includes("pantheon_repo_map"));
  assert.ok(tools.includes("pantheon_code_map"));
  assert.ok(tools.includes("pantheon_hook_trace"));
  assert.ok(tools.includes("pantheon_multiplexer_status"));
  assert.ok(tools.includes("pantheon_stats"));
  assert.ok(tools.includes("pantheon_spec_template"));
  assert.ok(tools.includes("pantheon_bootstrap"));
  assert.ok(tools.includes("pantheon_adapter_list"));
  assert.ok(tools.includes("pantheon_adapter_health"));
  assert.ok(tools.includes("pantheon_adapter_search"));
  assert.ok(tools.includes("pantheon_adapter_fetch"));
  assert.ok(tools.includes("pantheon_webfetch"));
  assert.ok(commands.includes("review"));
  assert.ok(commands.includes("pantheon"));
  assert.ok(commands.includes("pantheon-config"));
  assert.ok(commands.includes("pantheon-skills"));
  assert.ok(!commands.includes("pantheon-repo-map"));
  assert.ok(!commands.includes("pantheon-code-map"));
  assert.ok(commands.includes("pantheon-hooks"));
  assert.ok(commands.includes("pantheon-doctor"));
  assert.ok(commands.includes("pantheon-subagents"));
  assert.ok(commands.includes("pantheon-stats"));
  assert.ok(commands.includes("pantheon-version"));
  assert.ok(commands.includes("pantheon-update-check"));
  assert.ok(!commands.includes("pantheon-spec"));
  assert.ok(commands.includes("pantheon-spec-studio"));
  assert.ok(!commands.includes("pantheon-interview"));
  assert.ok(!commands.includes("interview"));
  assert.ok(commands.includes("pantheon-multiplexer"));
  assert.ok(commands.includes("pantheon-task-actions"));
  assert.ok(commands.includes("pantheon-sidebar"));
  assert.ok(commands.includes("pantheon-watch"));
  assert.ok(commands.includes("pantheon-bootstrap"));
  assert.ok(commands.includes("pantheon-regenerate"));
  assert.ok(commands.includes("pantheon-adapters"));
  assert.ok(commands.includes("pantheon-adapter-health"));
  assert.ok(handlers.includes("before_agent_start"));
  assert.ok(handlers.includes("context"));
  assert.ok(handlers.includes("before_provider_request"));
  assert.ok(handlers.includes("tool_result"));
});
