import type { PantheonConfig } from "../config.js";

export function resolveDelegateAttemptTimeoutMs(config: PantheonConfig, agentName: string): number {
  const agentTimeout = config.fallback?.agentTimeouts?.[agentName];
  if (typeof agentTimeout === "number" && Number.isFinite(agentTimeout) && agentTimeout >= 0) {
    return Math.floor(agentTimeout);
  }
  const delegateTimeoutMs = config.fallback?.delegateTimeoutMs;
  if (typeof delegateTimeoutMs === "number" && Number.isFinite(delegateTimeoutMs) && delegateTimeoutMs >= 0) {
    return Math.floor(delegateTimeoutMs);
  }
  return 0;
}

export function resolveCouncilAttemptTimeoutMs(config: PantheonConfig, kind: "master" | "councillors"): number {
  if (kind === "master") {
    return Math.max(1, Math.floor(config.council?.masterTimeoutMs ?? 300000));
  }
  return Math.max(1, Math.floor(config.council?.councillorsTimeoutMs ?? 180000));
}

export function resolveBackgroundAttemptTimeoutMs(config: PantheonConfig): number {
  const timeoutMs = config.fallback?.timeoutMs;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    return Math.floor(timeoutMs);
  }
  return 15000;
}

export function getFallbackModels(config: PantheonConfig, agentName: string, primary?: string): string[] {
  const chain = config.fallback?.agentChains?.[agentName] ?? [];
  return [primary, ...chain].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
}
