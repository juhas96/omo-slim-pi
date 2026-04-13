# Tools & Capabilities

Built-in tools available through the Pantheon pi port beyond the standard `read`, `edit`, `write`, and `bash` workflow.

## Delegate and council

- `pantheon_delegate` — run one specialist, multiple specialists in parallel, or a specialist chain
- `pantheon_council` — run multiple councillors in parallel and synthesize the answer with a master

## Background tasks

Use these when work should continue detached from the foreground flow:

- `pantheon_background`
- `pantheon_background_status`
- `pantheon_background_wait`
- `pantheon_background_result`
- `pantheon_background_watch`
- `pantheon_background_retry`
- `pantheon_background_cancel`
- `pantheon_background_log`
- `pantheon_background_attach`
- `pantheon_background_overview`

Related workflow-state tools:

- `pantheon_workflow_state`
- `pantheon_resume_context`
- `pantheon_auto_continue`
- `pantheon_spec_template`
- `pantheon_bootstrap`

Related command surfaces:

- `/pantheon-backgrounds` — overview report
- `/pantheon-watch <taskId>` — watch view
- `/pantheon-result <taskId>` — result view
- `/pantheon-task-actions <taskId>` — interactive retry/cancel/log/result/watch/attach menu
- `/pantheon-subagents` — live subagent inspector with per-agent expand/collapse plus quick actions for details, stdout, stderr, paths, and traces
- `/pantheon-doctor` — health-check report across config, adapters, tmux, and background storage

## Repo mapping and structural understanding

- `pantheon_repo_map` — file tree and hotspot summary
- `pantheon_code_map` — semantic entrypoints, imports, symbols, and hotspots

## Code intelligence

Pi-native LSP and structural editing tools include:

- `pantheon_lsp_goto_definition`
- `pantheon_lsp_hover`
- `pantheon_lsp_find_references`
- `pantheon_lsp_find_implementations`
- `pantheon_lsp_type_definition`
- `pantheon_lsp_symbols`
- `pantheon_lsp_diagnostics`
- `pantheon_lsp_rename`
- `pantheon_lsp_organize_imports`
- `pantheon_format_document`
- `pantheon_apply_patch`
- `pantheon_ast_grep_search`
- `pantheon_ast_grep_replace`

Supported surfaces currently include:

- TypeScript / JavaScript
- JSON / JSONC
- Python
- Go
- Rust

Support depth varies by language; see [runtime-parity.md](runtime-parity.md) for broader compatibility context.

## Patch and edit rescue

This port includes two resilience layers:

### `edit` rescue

Before pi's native `edit` runs, Pantheon can recover from small drift such as:

- CRLF vs LF
- trailing-space mismatch
- Unicode normalization drift
- anchor-based recovery for unique nearby blocks

### `pantheon_apply_patch`

For larger refactors, Pantheon also exposes a more patch-oriented path that can tolerate moved hunks and whitespace drift better than strict exact-match edits.

## Research and external docs

Direct research tools:

- `pantheon_webfetch`
- `pantheon_fetch`
- `pantheon_search`
- `pantheon_resolve_docs`
- `pantheon_fetch_docs`
- `pantheon_github_file`
- `pantheon_github_releases`
- `pantheon_npm_info`
- `pantheon_package_docs`

Use `pantheon_webfetch` when you want a smarter single-URL fetch for docs/static sites: it can probe `llms.txt`, extract main article content from HTML, and block unsafe cross-origin redirects by default. Keep `pantheon_fetch` for simpler raw page text retrieval.

Structured adapter tools:

- `pantheon_adapter_list`
- `pantheon_adapter_health`
- `pantheon_adapter_search`
- `pantheon_adapter_fetch`

## Observability and runtime inspection

For practical command selection and recovery sequences, see [workflows.md](workflows.md).


- `pantheon_stats`
- `pantheon_runtime_info`
- `pantheon_hook_trace`
- `pantheon_multiplexer_status`

Useful version/update commands:

- `/pantheon-version`
- `/pantheon-update-check`

These help debug orchestration behavior, runtime parity limitations, and active background-task state.

Long-running Pantheon commands such as delegate/council also stream partial UI updates before the final report lands, so foreground work no longer appears fully opaque while specialists are still running.

For orchestration validation workflows, see [evals.md](evals.md) for the deterministic scenario suite, approval fixtures, and benchmark harness.

See also:

- [mcps.md](mcps.md)
- [multiplexer-integration.md](multiplexer-integration.md)
- [runtime-parity.md](runtime-parity.md)
