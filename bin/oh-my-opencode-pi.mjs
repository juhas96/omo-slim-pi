#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage() {
  console.log(`oh-my-opencode-pi

Usage:
  oh-my-opencode-pi install [--cwd <dir>] [--global] [--reset] [--yes] [--tmux=yes|no] [--skills=yes|no]
  oh-my-opencode-pi verify [--cwd <dir>] [--global]
`);
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { flags._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    const next = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    flags[key] = next;
  }
  return flags;
}

function boolFlag(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function resolveInstallRoot(flags) {
  if (boolFlag(flags.global)) return path.join(os.homedir(), '.pi', 'agent');
  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
  return path.join(cwd, '.pi');
}

function buildConfig({ tmuxEnabled, skillsEnabled }) {
  return `{
  "$schema": "../oh-my-opencode-pi.schema.json",
  "extends": ["durable"],
  // The top-level pi session model stays whatever you selected in pi.
  // These overrides control delegated Pantheon specialists and council runs.
  "multiplexer": {
    "tmux": ${tmuxEnabled ? 'true' : 'false'},
    "layout": "main-vertical",
    "focusOnSpawn": false
  },
  "agents": {
    "oracle": {
      "model": "openai/gpt-4.1",
      "variant": "high"
    },
    "explorer": {
      "model": "openai/gpt-4.1-mini",
      "variant": "low",
      "allowSkills": ${skillsEnabled ? '["cartography"]' : '[]'},
      "allowedAdapters": ["local-docs", "docs-context7", "github-code-search", "web-search"]
    },
    "librarian": {
      "model": "openai/gpt-4.1-mini",
      "variant": "low",
      "allowedAdapters": ["local-docs", "docs-context7", "github-releases", "github-code-search", "web-search", "npm-registry"]
    },
    "designer": {
      "model": "openai/gpt-4.1-mini",
      "variant": "medium"
    },
    "fixer": {
      "model": "openai/gpt-4.1-mini",
      "variant": "low"
    }
  },
  "council": {
    "defaultPreset": "review-board",
    "presets": {
      "review-board": {
        "master": {
          "model": "openai/gpt-4.1",
          "variant": "high",
          "prompt": "Prioritize correctness, maintainability, and operational simplicity."
        },
        "councillors": [
          { "name": "reviewer", "model": "openai/gpt-4.1" },
          { "name": "architect", "model": "openai/gpt-4.1-mini", "variant": "medium" },
          { "name": "skeptic", "model": "openai/gpt-4.1-mini", "variant": "medium" }
        ]
      }
    }
  },
  "skills": {
    "defaultAllow": ${skillsEnabled ? '["cartography"]' : '[]'},
    "cartography": {
      "enabled": ${skillsEnabled ? 'true' : 'false'},
      "maxFiles": 250,
      "maxDepth": 4,
      "maxPerDirectory": 8
    }
  }
}
`;
}

function ensureFile(filePath, content, reset) {
  if (!reset && fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

function install(flags) {
  const root = resolveInstallRoot(flags);
  const tmuxEnabled = boolFlag(flags.tmux, false);
  const skillsEnabled = boolFlag(flags.skills, true);
  const reset = boolFlag(flags.reset, false);
  const configName = boolFlag(flags.global) ? 'oh-my-opencode-pi.jsonc' : 'oh-my-opencode-pi.jsonc';
  const created = [];
  const files = [
    [path.join(root, configName), buildConfig({ tmuxEnabled, skillsEnabled })],
    [path.join(root, 'pantheon-adapters', 'README.md'), '# Pantheon adapters\n\nDrop custom adapter modules (`.mjs`, `.js`, `.cjs`) in this directory to auto-load them.\n'],
    [path.join(root, 'agents', 'README.md'), '# Pantheon agents\n\nOverride or add project-local specialist agents here.\n'],
    [path.join(root, 'prompts', 'README.md'), '# Pantheon prompts\n\nStore project-specific prompt append/override files here.\n'],
  ];
  for (const [filePath, content] of files) {
    if (ensureFile(filePath, content, reset)) created.push(filePath);
  }
  console.log('Pantheon installer complete');
  console.log(`Root: ${root}`);
  console.log(`Created: ${created.length}`);
  for (const filePath of created) console.log(`- ${filePath}`);
  console.log('\nNext steps:');
  console.log('- Review the generated config');
  console.log('- Run /pantheon-config inside pi');
  console.log('- Try /pantheon-bootstrap or /pantheon-spec-studio if you want guided setup/spec flows');
}

function verify(flags) {
  const root = resolveInstallRoot(flags);
  const required = [
    path.join(root, 'oh-my-opencode-pi.jsonc'),
    path.join(root, 'pantheon-adapters', 'README.md'),
    path.join(root, 'agents', 'README.md'),
    path.join(root, 'prompts', 'README.md'),
  ];
  const missing = required.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length > 0) {
    console.error('Pantheon install verification failed');
    for (const filePath of missing) console.error(`- missing ${filePath}`);
    process.exitCode = 1;
    return;
  }
  console.log('Pantheon install verified');
  for (const filePath of required) console.log(`- ok ${filePath}`);
}

const flags = parseArgs(process.argv.slice(2));
const command = flags._[0] || 'install';
if (command === 'install') install(flags);
else if (command === 'verify') verify(flags);
else {
  usage();
  process.exitCode = 1;
}
