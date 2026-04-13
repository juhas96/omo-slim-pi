# MCPs / Adapters

Upstream `oh-my-opencode-slim` documents MCP server access. In the pi port, the closest equivalent is the **adapter system**.

## What changed in the pi port

This package does **not** depend on OpenCode MCP runtime semantics. Instead it provides structured research adapters that cover the same practical jobs:

- docs lookup
- package metadata lookup
- release notes lookup
- public code search
- generic web search/fetch
- repository-local markdown/docs search

This package documents pi-specific research behavior directly rather than maintaining a separate upstream-comparison page.

---

## Built-in adapters

| Adapter | Purpose |
|--------|---------|
| `local-docs` | Search local README/docs markdown in the current repository |
| `docs-context7` | Docs/package/site-aware resolution and fetch |
| `grep-app` | Public code search |
| `github-code-search` | Structured GitHub code search within a target repo |
| `web-search` | Generic fallback web search/fetch |
| `github-releases` | Release notes and changelog retrieval |
| `npm-registry` | Package metadata and README/docs retrieval |

---

## Adapter policy controls

### Global policy

- `adapters.disableAll`
- `adapters.disabled`
- `adapters.defaultAllow`
- `adapters.defaultDeny`
- `adapters.modules`

### Per-agent policy

- `agents.<name>.allowedAdapters`
- `agents.<name>.deniedAdapters`

Wildcard-style semantics are supported. For example:

```jsonc
{
  "adapters": {
    "defaultAllow": ["*"],
    "defaultDeny": ["github-releases"]
  },
  "agents": {
    "fixer": {
      "deniedAdapters": ["*"]
    },
    "librarian": {
      "allowedAdapters": ["local-docs", "docs-context7", "npm-registry", "web-search"]
    }
  }
}
```

---

## Commands and tools

The adapter search flow now includes selection reporting so you can see why auto-selection chose specific adapters before reading result sections.


### Commands

- `/pantheon-adapters`
- `/pantheon-adapter-health`

### Tools

- `pantheon_adapter_list`
- `pantheon_adapter_health`
- `pantheon_adapter_search`
- `pantheon_adapter_fetch`

These are complemented by the direct fetch/search tools:

- `pantheon_fetch`
- `pantheon_search`
- `pantheon_fetch_docs`
- `pantheon_resolve_docs`
- `pantheon_github_file`
- `pantheon_github_releases`
- `pantheon_npm_info`
- `pantheon_package_docs`

---

## Custom adapters

Custom adapter modules can be loaded from:

- `adapters.modules` in config
- `~/.pi/agent/pantheon-adapters/`
- `.pi/pantheon-adapters/`

The project bootstrap command scaffolds the project-local adapter directory for you.

A custom adapter module exports a default object with fields like:

- `id`
- `label`
- `description`
- optional `auth` / `health`
- `search()` and/or `fetch()` handlers

---

## Practical guidance

- Give `librarian` the broadest adapter access.
- Give `explorer` code-search and local-doc access.
- Keep `fixer` narrower unless implementation really needs external research.
- Use `local-docs` first when the answer may already exist in the repo.

See also:

- [tools.md](tools.md)
- [configuration.md](configuration.md)
