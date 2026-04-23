#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPantheonScaffoldEntries, getPantheonScaffoldRequiredPaths } from '../shared/scaffold.mjs';

function usage() {
  console.log(`oh-my-opencode-pi

Usage:
  oh-my-opencode-pi install [--cwd <dir>] [--global] [--reset] [--yes] [--tmux=yes|no] [--skills=yes|no]
  oh-my-opencode-pi regenerate [--cwd <dir>] [--global] [--yes] [--tmux=yes|no] [--skills=yes|no]
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

function ensureFile(filePath, content, reset) {
  if (!reset && fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

function install(flags, options = {}) {
  const root = resolveInstallRoot(flags);
  const tmuxEnabled = boolFlag(flags.tmux, false);
  const skillsEnabled = boolFlag(flags.skills, true);
  const reset = options.reset ?? boolFlag(flags.reset, false);
  const label = options.label ?? 'install';
  const created = [];
  const files = getPantheonScaffoldEntries({ tmuxEnabled, skillsEnabled })
    .map((entry) => [path.join(root, entry.relativePath), entry.content]);
  for (const [filePath, content] of files) {
    if (ensureFile(filePath, content, reset)) created.push(filePath);
  }
  console.log(`Pantheon scaffold ${label} complete`);
  console.log(`Root: ${root}`);
  console.log(`Created: ${created.length}`);
  for (const filePath of created) console.log(`- ${filePath}`);
  console.log('\nNext steps:');
  console.log('- Review the generated config and provider choices');
  console.log('- Runtime verification happens inside pi: run /pantheon, /pantheon-config, and /pantheon-doctor');
  console.log('- If you enabled tmux integration, verify you are inside a tmux session before expecting background panes');
  console.log('- Try /pantheon-bootstrap or /pantheon-spec-studio if you want guided setup/spec flows');
}

function verify(flags) {
  const root = resolveInstallRoot(flags);
  const required = getPantheonScaffoldRequiredPaths().map((relativePath) => path.join(root, relativePath));
  const missing = required.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length > 0) {
    console.error('Pantheon scaffold verification failed');
    for (const filePath of missing) console.error(`- missing ${filePath}`);
    process.exitCode = 1;
    return;
  }
  console.log('Pantheon scaffold verified');
  for (const filePath of required) console.log(`- ok ${filePath}`);
  console.log('\nNote: this verifies generated scaffold files only.');
  console.log('For runtime readiness, open pi in the target project and run /pantheon, /pantheon-config, and /pantheon-doctor.');
}

const flags = parseArgs(process.argv.slice(2));
const command = flags._[0] || 'install';
if (command === 'install') install(flags);
else if (command === 'regenerate' || command === 'regen') install(flags, { reset: true, label: 'regenerate' });
else if (command === 'verify') verify(flags);
else {
  usage();
  process.exitCode = 1;
}
