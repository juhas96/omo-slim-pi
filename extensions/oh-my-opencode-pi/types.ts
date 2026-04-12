import type { Message } from "@mariozechner/pi-ai";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "bundled" | "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  abortReason?: string;
  step?: number;
}

export interface BackgroundTaskRecord {
  id: string;
  agent: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  model?: string;
  logPath: string;
  resultPath: string;
  specPath?: string;
  paneId?: string;
  pid?: number;
  result?: SingleResult;
}

export interface BackgroundTaskSpec {
  agent: string;
  task: string;
  cwd: string;
  model?: string;
  models?: string[];
  options?: string[];
  tools?: string[];
  noTools?: boolean;
  systemPrompt?: string;
  piCommand: string;
  piBaseArgs?: string[];
  timeoutMs?: number;
  retryDelayMs?: number;
  retryOnEmpty?: boolean;
  logPath: string;
  resultPath: string;
  meta: BackgroundTaskRecord;
  includeProjectAgents?: boolean;
  depth?: number;
}
