# Parity Plan

Focused roadmap for pushing `oh-my-opencode-pi` closer to `oh-my-opencode-slim` in the highest-return areas.

Removed for now:
- installer / bootstrap CLI
- multiplexer parity
- interview web UI

## Priorities

### 1. Tooling parity
Add Pi-native equivalents for the most important missing tools:
- LSP tools
  - goto definition
  - find references
  - diagnostics
  - rename
- AST-grep tools
  - structural search
  - structural replace
- smarter fetch / docs retrieval

Why:
- biggest real capability gap
- improves explorer, fixer, librarian, and oracle immediately

## 2. Config / preset system
Add a stronger config surface closer to the original package:
- named presets
- per-agent model / options / variant
- prompt override / append files
- JSONC support
- deep merge for user + project config

Why:
- original package treats config as a major product surface
- unlocks better routing, customization, and reproducibility

## 3. Hook / runtime resilience parity
Add Pi-native runtime polish and recovery:
- foreground fallback manager
- JSON error recovery
- phase reminders
- post-file-tool nudges
- delegate retry guidance
- stronger edit / patch resilience

Why:
- large quality and reliability gain
- makes the system feel much closer to the original under failure

## 4. Refactor + tests / CI baseline
Reduce implementation risk before more parity work:
- split `extensions/oh-my-opencode-pi/index.ts` into subsystems
  - config
  - tools
  - hooks
  - background
  - ui
  - workflow
- add smoke tests for
  - delegate
  - council
  - config loading
  - background flows
- add CI

Why:
- increases delivery speed for all later parity work
- reduces regression risk

## 5. Skills / cartography parity
Add repo-understanding support closer to the original:
- bundled Pi-native cartography / codemap skill
- per-agent skill allow / deny policy
- optional skill setup flow

Why:
- improves reconnaissance and planning quality
- high value for explorer and orchestrator workflows

## 6. MCP-like adapter system
Extend current research helpers into a more structured source system:
- pluggable adapters
- agent-level permissions
- Context7-like docs source
- grep.app-like source
- global disable controls

Why:
- closes more of the original research / retrieval gap
- complements librarian and oracle workflows

## Recommended execution order
1. Minimal refactor scaffold
2. Config / preset system
3. LSP tools
4. AST-grep tools
5. Foreground fallback + JSON recovery hooks
6. Test harness + CI
7. Skills / cartography
8. MCP-like adapter system

## Near-term implementation shape

### Phase 1
Create modules for:
- `extensions/oh-my-opencode-pi/config.ts`
- `extensions/oh-my-opencode-pi/tools/lsp.ts`
- `extensions/oh-my-opencode-pi/tools/ast-grep.ts`
- `extensions/oh-my-opencode-pi/hooks/fallback.ts`
- `extensions/oh-my-opencode-pi/hooks/json-recovery.ts`

### Phase 2
Implement:
- config/preset parity
- LSP tools
- AST-grep tools
- foreground fallback hook

### Phase 3
Add:
- tests
- CI
- skills/cartography
- MCP-like adapter structure
