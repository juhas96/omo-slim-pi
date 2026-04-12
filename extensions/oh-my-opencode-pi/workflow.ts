import * as fs from "node:fs";
import * as path from "node:path";
import type { PantheonConfig } from "./config.js";
import type { BackgroundTaskRecord } from "./types.js";

export interface WorkflowState {
  updatedAt: number;
  uncheckedTodos: string[];
  lastAgentSummary?: string;
  recentBackgroundTaskIds?: string[];
}

function previewText(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}

export function countUncheckedTodos(text: string): number {
  const matches = text.match(/^\s*[-*]\s+\[\s\]\s+/gm);
  return matches ? matches.length : 0;
}

export function hasUncheckedTodos(text: string): boolean {
  return countUncheckedTodos(text) > 0;
}

export function extractUncheckedTodoItems(text: string): string[] {
  return [...text.matchAll(/^\s*[-*]\s+\[\s\]\s+(.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
}

export function resolveWorkflowStatePath(cwd: string, config: PantheonConfig): string {
  const configured = config.workflow?.stateFile?.trim() || ".oh-my-opencode-pi-workflow.json";
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

export function readWorkflowState(cwd: string, config: PantheonConfig): WorkflowState {
  const filePath = resolveWorkflowStatePath(cwd, config);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkflowState>;
    return {
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      uncheckedTodos: Array.isArray(parsed.uncheckedTodos) ? parsed.uncheckedTodos.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
      lastAgentSummary: typeof parsed.lastAgentSummary === "string" ? parsed.lastAgentSummary : undefined,
      recentBackgroundTaskIds: Array.isArray(parsed.recentBackgroundTaskIds) ? parsed.recentBackgroundTaskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    };
  } catch {
    return { updatedAt: 0, uncheckedTodos: [], recentBackgroundTaskIds: [] };
  }
}

export function writeWorkflowState(cwd: string, config: PantheonConfig, state: WorkflowState): WorkflowState {
  const filePath = resolveWorkflowStatePath(cwd, config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized: WorkflowState = {
    updatedAt: state.updatedAt || Date.now(),
    uncheckedTodos: state.uncheckedTodos.filter((item) => item.trim().length > 0),
    lastAgentSummary: state.lastAgentSummary?.trim() || undefined,
    recentBackgroundTaskIds: (state.recentBackgroundTaskIds ?? []).filter((item, index, array) => item.trim().length > 0 && array.indexOf(item) === index).slice(-20),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function updateWorkflowState(cwd: string, config: PantheonConfig, mutate: (state: WorkflowState) => WorkflowState): WorkflowState {
  const current = readWorkflowState(cwd, config);
  const next = mutate(current);
  next.updatedAt = Date.now();
  return writeWorkflowState(cwd, config, next);
}

export function renderWorkflowState(state: WorkflowState): string {
  const sections = [
    `Updated: ${state.updatedAt ? new Date(state.updatedAt).toISOString() : "(never)"}`,
    state.uncheckedTodos.length > 0 ? `\nUnchecked todos:\n${state.uncheckedTodos.map((item) => `- [ ] ${item}`).join("\n")}` : "\nUnchecked todos:\n(none)",
    state.lastAgentSummary ? `\nLast agent summary:\n${state.lastAgentSummary}` : undefined,
    state.recentBackgroundTaskIds && state.recentBackgroundTaskIds.length > 0 ? `\nRecent background task ids:\n${state.recentBackgroundTaskIds.map((item) => `- ${item}`).join("\n")}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return sections.join("\n");
}

export function buildResumeContext(state: WorkflowState, tasks: BackgroundTaskRecord[], options?: {
  maxTasks?: number;
  includeCompletedBackground?: boolean;
  includeFailedBackground?: boolean;
}): string {
  const maxTasks = Math.max(1, Math.floor(options?.maxTasks ?? 6));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const prioritized = (state.recentBackgroundTaskIds ?? [])
    .map((id) => taskById.get(id))
    .filter((task): task is BackgroundTaskRecord => Boolean(task))
    .filter((task) => {
      if (task.status === "completed") return options?.includeCompletedBackground !== false;
      if (task.status === "failed" || task.status === "cancelled") return options?.includeFailedBackground !== false;
      return true;
    });

  const selectedTasks = prioritized.slice(0, maxTasks);
  const taskLines = selectedTasks.length > 0
    ? selectedTasks.map((task) => `- ${task.id} [${task.status}] ${task.agent}: ${task.summary ?? previewText(task.task, 120)}`).join("\n")
    : "- (no recent background tasks selected)";

  return [
    "Pantheon resume context:",
    state.uncheckedTodos.length > 0 ? `\nPersisted unchecked todos:\n${state.uncheckedTodos.map((item) => `- [ ] ${item}`).join("\n")}` : "\nPersisted unchecked todos:\n- (none)",
    state.lastAgentSummary ? `\nLast agent summary:\n${state.lastAgentSummary}` : undefined,
    `\nRelevant background tasks:\n${taskLines}`,
    "\nSuggested next step: reconcile remaining todos with completed/failed background work before launching duplicate tasks.",
  ].filter((item): item is string => Boolean(item)).join("\n");
}

export function taskLooksMultiStep(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\b(and|then|also|plus|along with|end-to-end|migration|roadmap|plan|audit|refactor|overhaul)\b/.test(lower)
    || /\b\d+\.|\n-\s|\n\*\s/.test(prompt)
    || prompt.length > 260;
}

export function buildWorkflowHints(prompt: string, config: PantheonConfig, activeBackgroundTasks: number, state?: WorkflowState): string {
  const lower = prompt.toLowerCase();
  const hints: string[] = [];

  if ((config.workflow?.phaseReminders ?? true) && taskLooksMultiStep(prompt)) {
    if (/\b(debug|bug|failure|flaky|error|regression)\b/.test(lower)) {
      hints.push("Phase reminder: reproduce → isolate → fix → verify.");
    } else if (/\b(refactor|migration|rewrite|overhaul)\b/.test(lower)) {
      hints.push("Phase reminder: map current state → plan bounded changes → implement incrementally → verify.");
    } else {
      hints.push("Phase reminder: scout → plan → implement → verify.");
    }
  }

  if (/\b(doc|docs|documentation|api|sdk|library|version|changelog|official|readme)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `librarian` when library or API behavior matters.");
  }
  if (/\b(find|where|which file|entrypoint|trace|search|locate|recon|explore|map the codebase)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `explorer` for reconnaissance before opening many files yourself.");
  }
  if (/\b(ui|ux|design|css|layout|responsive|accessibility|a11y|animation|visual)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `designer` for user-facing polish or frontend ergonomics.");
  }
  if (/\b(architecture|trade-?off|should we|security|risky|ambiguous|decision|review|debug)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `oracle` or `pantheon_council` when the task is high-stakes or ambiguous.");
  }
  if (/\b(implement|change|edit|patch|refactor|fix|add tests|write tests|ship)\b/.test(lower)) {
    hints.push("Use `pantheon_delegate` with `fixer` for bounded implementation-heavy work after requirements are clear.");
  }
  if (taskLooksMultiStep(prompt)) {
    hints.push("Break complex work into explicit todos and parallelize independent research or implementation when safe.");
    if (!(config.autoContinue?.enabled ?? false)) {
      hints.push("If you create a multi-step todo list, consider enabling auto-continue with `/pantheon-auto-continue on` or `pantheon_auto_continue`.");
    }
  }
  if ((config.workflow?.backgroundAwareness ?? true) && activeBackgroundTasks > 0) {
    hints.push(`There ${activeBackgroundTasks === 1 ? "is" : "are"} ${activeBackgroundTasks} active Pantheon background task${activeBackgroundTasks === 1 ? "" : "s"}; check ` + "`pantheon_background_status` before duplicating work.");
  }
  if ((state?.uncheckedTodos.length ?? 0) > 0) {
    hints.push(`There ${state!.uncheckedTodos.length === 1 ? "is" : "are"} ${state!.uncheckedTodos.length} persisted unchecked todo${state!.uncheckedTodos.length === 1 ? "" : "s"} from earlier work; reconcile them before starting duplicate work.`);
  }

  const uniqueHints = hints.filter((hint, index) => hints.indexOf(hint) === index);
  if (uniqueHints.length === 0) return "";
  return `\n\n<PantheonWorkflowHints>\n${uniqueHints.map((hint) => `- ${hint}`).join("\n")}\n</PantheonWorkflowHints>`;
}
