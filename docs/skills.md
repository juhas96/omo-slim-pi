# Skills

Skills are prompt-level capabilities you allow specific Pantheon agents to use. They are not running servers; they are instruction bundles that change how an agent approaches work.

## Bundled skill in this repository

### `cartography`

This package bundles one first-class skill:

- `cartography` — repository understanding and hierarchical codemap generation

It lives at:

- `skills/cartography/SKILL.md`

Use it when you want:

- repository onboarding
- codebase mapping
- `codemap.md` generation or refreshes
- architecture atlases for future agents

## Skill policy controls

Pantheon lets you control skills globally and per agent.

### Global

- `skills.setupHints`
- `skills.defaultAllow`
- `skills.defaultDeny`

### Per-agent

- `agents.<name>.allowSkills`
- `agents.<name>.denySkills`

Example:

```jsonc
{
  "skills": {
    "defaultAllow": ["cartography"]
  },
  "agents": {
    "explorer": {
      "allowSkills": ["cartography"]
    },
    "fixer": {
      "denySkills": ["cartography"]
    }
  }
}
```

## Commands and helpers

Useful commands:

- `/pantheon-skills` — inspect effective skill guidance
- `/skill:cartography` — run the bundled cartography workflow directly
- `/pantheon-bootstrap` — scaffold project-local Pantheon files including a starter config

## Setup hints

When `skills.setupHints` is enabled, Pantheon reminds the orchestrator about the bundled skill surface so it can route repo-mapping work to the right workflow.

## Skills beyond this repo

Pi can use other skills installed in your environment or project. This package only bundles `cartography`, but the allow/deny fields are generic and can be used for additional skills available in your pi setup.

See also:

- [cartography.md](cartography.md)
- [configuration.md](configuration.md)
