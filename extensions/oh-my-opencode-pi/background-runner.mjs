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
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttempt(spec, model) {
  const args = [...(spec.piBaseArgs ?? []), "--mode", "json", "-p", "--no-session"];
  if (model) args.push("--model", model);
  if (spec.options?.length) args.push(...spec.options);
  if (spec.noTools) args.push("--no-tools");
  else if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
  if (spec.systemPrompt?.trim()) args.push("--append-system-prompt", spec.systemPrompt);
  args.push(`Task: ${spec.task}`);

  const result = {
    agent: spec.agent,
    task: spec.task,
    exitCode: 0,
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
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          result.abortReason = "timeout";
          result.stopReason = "aborted";
          result.errorMessage = "Subagent aborted (timeout)";
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        }, timeoutMs)
      : undefined;
    const cleanupTimer = () => {
      if (timer) clearTimeout(timer);
    };

    const log = fs.createWriteStream(spec.logPath, { flags: "a" });
    let buffer = "";

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
        }
      }
      if (event.type === "tool_result_end" && event.message) result.messages.push(event.message);
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr.on("data", (data) => {
      const text = data.toString();
      result.stderr += text;
      log.write(text);
    });
    proc.on("close", (code) => {
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
  writeJson(spec.resultPath, { ...existing, ...spec.meta, status: "running", startedAt: Date.now(), pid: process.pid });

  const models = spec.models?.length ? spec.models : [spec.model];
  const retryOnEmpty = spec.retryOnEmpty !== false;
  const retryDelayMs = Number.isFinite(spec.retryDelayMs) ? Math.max(0, Math.floor(spec.retryDelayMs)) : 500;

  let finalResult = null;
  let finalOk = false;
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const result = await runAttempt(spec, model);
    const emptyResponse = !hasMeaningfulResult(result);
    if (emptyResponse && retryOnEmpty && !result.errorMessage) {
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
  writeJson(spec.resultPath, {
    ...(readJsonSafe(spec.resultPath) ?? {}),
    ...spec.meta,
    status: finalOk ? "completed" : "failed",
    finishedAt: Date.now(),
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
      summary: error instanceof Error ? error.message : String(error),
      logPath: spec.logPath,
    });
  }
  process.exit(1);
});
