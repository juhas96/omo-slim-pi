import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return undefined;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function getFinalOutput(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content ?? []) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function summarize(result) {
  return getFinalOutput(result.messages).trim() || result.errorMessage || result.stderr?.trim() || "(no output)";
}

function hasMeaningfulResult(result) {
  return getFinalOutput(result.messages).trim().length > 0;
}

function extractTextFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isLikelyFinalAssistantMessage(message) {
  if (message?.role !== "assistant") return false;
  if (!extractTextFromMessage(message)) return false;
  return Boolean(message.stopReason && !["aborted", "error", "tool_use"].includes(message.stopReason));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CORE_CLI_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function canUseCliToolFilter(tools) {
  return Boolean(tools?.length) && tools.every((tool) => CORE_CLI_TOOL_NAMES.has(tool));
}

function buildSubagentSystemPrompt(systemPrompt, tools, noTools) {
  const parts = [systemPrompt?.trim() ?? ""];
  if (!noTools && tools?.length && !canUseCliToolFilter(tools)) {
    parts.push([
      "Tool policy:",
      `- Your allowed tools for this task are: ${tools.join(", ")}.`,
      "- Do not use tools outside that allowlist, even if they appear in the runtime.",
      "- This allowlist is prompt-enforced because pi CLI --tools filtering only recognizes core built-in tools before extensions load.",
    ].join("\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

async function runAttempt(spec, model) {
  const args = [...(spec.piBaseArgs ?? []), "--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (spec.options?.length) args.push(...spec.options);
  if (spec.noTools) args.push("--no-tools");
  else if (canUseCliToolFilter(spec.tools)) args.push("--tools", spec.tools.join(","));
  const systemPrompt = buildSubagentSystemPrompt(spec.systemPrompt, spec.tools, spec.noTools);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  args.push(`Task: ${spec.task}`);

  const result = {
    agent: spec.agent,
    task: spec.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    model,
    stopReason: undefined,
    errorMessage: undefined,
  };

  return await new Promise((resolve) => {
    const proc = spawn(spec.piCommand, args, {
      cwd: spec.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OH_MY_OPENCODE_PI_SUBAGENT: "1",
        OH_MY_OPENCODE_PI_AGENT: spec.agent,
      },
      detached: false,
    });
    const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.max(0, Math.floor(spec.timeoutMs)) : 0;
    let timedOut = false;
    let timer;
    const forceKill = () => {
      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };
    const triggerTimeout = () => {
      if (timedOut || proc.exitCode !== null) return;
      timedOut = true;
      result.abortReason = "timeout";
      result.stopReason = "aborted";
      result.errorMessage = "Subagent aborted (timeout)";
      proc.kill("SIGTERM");
      forceKill();
    };
    const cleanupTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const armTimeout = () => {
      if (timeoutMs <= 0 || timedOut) return;
      cleanupTimer();
      timer = setTimeout(triggerTimeout, timeoutMs);
    };
    const noteActivity = () => {
      if (timeoutMs <= 0 || timedOut) return;
      armTimeout();
    };
    armTimeout();

    const log = fs.createWriteStream(spec.logPath, { flags: "a" });
    let buffer = "";
    let lingerTimer;
    const finalMessageGraceMs = Number.isFinite(spec.finalMessageGraceMs) ? Math.max(0, Math.floor(spec.finalMessageGraceMs)) : 1500;

    const clearLingerTimer = () => {
      if (!lingerTimer) return;
      clearTimeout(lingerTimer);
      lingerTimer = undefined;
    };

    const scheduleLingerShutdown = () => {
      if (lingerTimer) return;
      lingerTimer = setTimeout(() => {
        lingerTimer = undefined;
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
      }, finalMessageGraceMs);
    };

    const processLine = (line) => {
      if (!line.trim()) return;
      log.write(`${line}\n`);
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_end" && event.message) {
        result.messages.push(event.message);
        if (event.message.role === "assistant") {
          result.stopReason = event.message.stopReason;
          result.errorMessage = event.message.errorMessage;
          if (!result.model && event.message.model) result.model = event.message.model;
          if (isLikelyFinalAssistantMessage(event.message)) scheduleLingerShutdown();
        }
      }
      if (event.type === "tool_result_end" && event.message) result.messages.push(event.message);
    };

    proc.stdout.on("data", (data) => {
      noteActivity();
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data) => {
      noteActivity();
      const text = data.toString();
      result.stderr += text;
      log.write(text);
    });
    proc.on("close", (code) => {
      clearLingerTimer();
      if (buffer.trim()) processLine(buffer);
      result.exitCode = code ?? 0;
      if (timedOut && !result.stderr.includes("Subagent aborted (timeout)")) {
        result.stderr += `${result.stderr ? "\n" : ""}Subagent aborted (timeout)`;
      }
      cleanupTimer();
      log.end();
      resolve(result);
    });
    proc.on("error", (error) => {
      clearLingerTimer();
      result.exitCode = 1;
      result.stderr += String(error);
      cleanupTimer();
      log.end();
      resolve(result);
    });
  });
}

async function main() {
  const specPath = process.argv[2];
  const spec = readJson(specPath);
  const existing = readJsonSafe(spec.resultPath) ?? {};
  const heartbeatIntervalMs = Number.isFinite(spec.heartbeatIntervalMs) ? Math.max(250, Math.floor(spec.heartbeatIntervalMs)) : 1500;
  writeJson(spec.resultPath, {
    ...existing,
    ...spec.meta,
    status: "running",
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    pid: process.pid,
  });
  const heartbeat = setInterval(() => {
    writeJson(spec.resultPath, {
      ...(readJsonSafe(spec.resultPath) ?? {}),
      ...(spec.meta ?? {}),
      status: "running",
      heartbeatAt: Date.now(),
      pid: process.pid,
      logPath: spec.logPath,
    });
  }, heartbeatIntervalMs);

  const models = spec.models?.length ? spec.models : [spec.model];
  const retryOnEmpty = spec.retryOnEmpty !== false;
  const retryDelayMs = Number.isFinite(spec.retryDelayMs) ? Math.max(0, Math.floor(spec.retryDelayMs)) : 500;

  let finalResult = null;
  let finalOk = false;
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const result = await runAttempt(spec, model);
    const emptyResponse = !hasMeaningfulResult(result);
    if (emptyResponse && retryOnEmpty && !result.errorMessage && !result.stderr.trim()) {
      result.errorMessage = "Empty response from provider";
    }
    const ok = result.exitCode === 0
      && result.stopReason !== "error"
      && result.stopReason !== "aborted"
      && (!retryOnEmpty || !emptyResponse);
    finalResult = result;
    finalOk = ok;
    if (ok) break;
    if (index < models.length - 1 && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  const summary = summarize(finalResult ?? { messages: [], stderr: "", errorMessage: "No result" });
  clearInterval(heartbeat);
  writeJson(spec.resultPath, {
    ...(readJsonSafe(spec.resultPath) ?? {}),
    ...spec.meta,
    status: finalOk ? "completed" : "failed",
    finishedAt: Date.now(),
    heartbeatAt: Date.now(),
    model: finalResult?.model,
    summary,
    result: finalResult,
    logPath: spec.logPath,
  });
}

process.on("SIGTERM", () => {
  const spec = process.argv[2] && fs.existsSync(process.argv[2]) ? readJson(process.argv[2]) : undefined;
  if (spec?.resultPath) {
    writeJson(spec.resultPath, {
      ...(readJsonSafe(spec.resultPath) ?? {}),
      ...(spec.meta ?? {}),
      status: "cancelled",
      finishedAt: Date.now(),
      heartbeatAt: Date.now(),
      summary: "Cancelled by user",
      logPath: spec.logPath,
      pid: process.pid,
    });
  }
  process.exit(0);
});

main().catch((error) => {
  const spec = process.argv[2] && fs.existsSync(process.argv[2]) ? readJson(process.argv[2]) : undefined;
  if (spec?.resultPath) {
    writeJson(spec.resultPath, {
      ...(readJsonSafe(spec.resultPath) ?? {}),
      ...(spec.meta ?? {}),
      status: "failed",
      finishedAt: Date.now(),
      heartbeatAt: Date.now(),
      summary: error instanceof Error ? error.message : String(error),
      logPath: spec.logPath,
    });
  }
  process.exit(1);
});
