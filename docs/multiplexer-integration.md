# Multiplexer Integration Guide

The pi port currently provides **tmux-focused** multiplexer integration for Pantheon background work.

## Overview

When Pantheon launches background specialists, it can open or reuse tmux panes so you can watch live logs without leaving the main session.

Key benefits:

- real-time visibility into background work
- project-scoped background windows
- pane reuse and reopen support
- attach/watch/log/result commands for detached runs
- layout control for shared tmux windows

---

## Requirements

Multiplexer integration works when all of the following are true:

- `multiplexer.tmux` is `true`
- you are already inside a tmux session
- background work is launched through Pantheon commands/tools

If you are not in tmux, Pantheon still runs background jobs; it just skips pane spawning.

---

## Quick setup

```jsonc
{
  "multiplexer": {
    "tmux": true,
    "layout": "main-vertical",
    "splitDirection": "vertical",
    "focusOnSpawn": false,
    "keepPaneOnFinish": false,
    "reuseWindow": true,
    "windowName": "pantheon-bg",
    "projectScopedWindow": true
  }
}
```

---

## Important settings

| Field | Purpose |
|------|---------|
| `tmux` | Enable tmux integration |
| `splitDirection` | Use vertical or horizontal pane splits |
| `layout` | Apply a tmux layout like `main-vertical`, `main-horizontal`, or `tiled` |
| `focusOnSpawn` | Jump focus to the spawned pane/window |
| `keepPaneOnFinish` | Keep panes open after task completion |
| `reuseWindow` | Reuse a shared tmux window for Pantheon panes |
| `windowName` | Base window name |
| `projectScopedWindow` | Add a project-specific suffix so repositories do not collide |

---

## Useful commands

- `/pantheon-backgrounds`
- `/pantheon-attach [taskId]`
- `/pantheon-attach-all`
- `/pantheon-watch [taskId]`
- `/pantheon-log [taskId]`
- `/pantheon-result [taskId]`
- `/pantheon-cancel [taskId]`
- `/pantheon-multiplexer`

Tool equivalents also exist, especially `pantheon_multiplexer_status` and the `pantheon_background_*` family.

---

## How pane reuse works

By default Pantheon tries to reuse a shared tmux window and uses project-scoped naming so multiple repositories can coexist more safely.

If `background.reuseSessions` is enabled, identical active background runs can also reuse the existing session instead of spawning duplicate work.

---

## Troubleshooting

### No panes appear

Check:

- `echo $TMUX`
- `multiplexer.tmux: true`
- whether the task was launched as a Pantheon background task

### Panes close too quickly

Set:

```jsonc
{
  "multiplexer": {
    "keepPaneOnFinish": true
  }
}
```

### Repos share one window unexpectedly

Set:

```jsonc
{
  "multiplexer": {
    "projectScopedWindow": true
  }
}
```

### Need a status snapshot

Run:

```text
/pantheon-multiplexer
```

or call:

- `pantheon_multiplexer_status`

See also:

- [tools.md](tools.md)
- [configuration.md](configuration.md)
