import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const STOP_HOOK = join(ROOT, "copilot-stop-hook.js");
export const BACKFILL = join(ROOT, "backfill-sessions.mjs");
export const STUB = join(ROOT, "test", "stub-pali.mjs");

/** A fresh temp dir; tests may nest their hooks/backfill fixtures inside. */
export function tempDir(prefix = "pali-hook-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Path to the stub MCP server, with the exec bit the hook's spawn needs. */
export function stubBin() {
  chmodSync(STUB, 0o755);
  return STUB;
}

/**
 * Environment for a hook run. Everything the modules can reach is redirected
 * into the test's temp dir, so no test can write to the real memory store.
 */
export function hookEnv(dir, overrides = {}) {
  const env = {
    ...process.env,
    PALI_BIN: stubBin(),
    PALI_SCOPE: "test-project",
    PALI_HOOK_STATE_DIR: join(dir, "state"),
    PALI_HOOK_LOG_FILE: join(dir, "hook.log"),
    PALI_HOOK_LOG_LEVEL: "off",
    PALI_HOOK_KEEP_SESSIONS: "0",
    PALI_HOOK_CAPTURE: "",
    PALI_HOOK_DISABLE: "",
    STUB_LOG: join(dir, "calls.jsonl"),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/** Run one hook as the host would: JSON event on stdin, silence expected on stdout. */
export function runHook(env, event, { cwd, script = STOP_HOOK, input } = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: cwd ?? tmpdir(),
    env,
    input: input ?? JSON.stringify(event ?? {}),
    encoding: "utf8",
    timeout: 60000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Every `tools/call` the stub received, in order. */
export function readCalls(env) {
  const file = env.STUB_LOG;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function callsOf(env, tool) {
  return readCalls(env).filter((call) => call.tool === tool);
}

/** Write a transcript JSONL file and return its path. */
export function writeTranscript(dir, events, name = "events.jsonl") {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return path;
}

// --- Copilot transcript event builders -------------------------------------

const TS = "2026-10-28T10:00:00.000Z";

export function user(content, timestamp = TS) {
  return { type: "user.message", timestamp, data: { content } };
}

export function assistant(content, timestamp = TS) {
  return { type: "assistant.message", timestamp, data: { content } };
}

export function toolStart(id, toolName, args) {
  return { type: "tool.execution_start", timestamp: TS, data: { toolCallId: id, toolName, arguments: args } };
}

export function toolOk(id, extra = {}) {
  return { type: "tool.execution_complete", timestamp: TS, data: { toolCallId: id, success: true, ...extra } };
}

export function toolFail(id, error, extra = {}) {
  return {
    type: "tool.execution_complete",
    timestamp: TS,
    data: { toolCallId: id, success: false, error: { message: error }, ...extra },
  };
}

/** A small but representative session: request, edits, commands, a failure. */
export function sampleSession() {
  return [
    user("Fix the login redirect loop in the desktop app", "2026-10-28T10:00:00.000Z"),
    assistant("I will inspect the auth handler first.", "2026-10-28T10:00:05.000Z"),
    toolStart("t1", "view", { path: "src/auth/handler.ts" }),
    toolOk("t1"),
    toolStart("t2", "edit", { path: "src/auth/handler.ts", new_str: "if (!token) return redirect();" }),
    toolOk("t2"),
    toolStart("t3", "bash", { command: "dotnet build Nethereum.UI.Desktop.sln" }),
    toolFail("t3", "MSBuild failed", { shellExecution: { exitCode: 1 } }),
    toolStart("t4", "create", { path: "src/auth/redirect.ts", file_text: "export const redirect = () => {};" }),
    toolOk("t4"),
    toolStart("t5", "bash", { command: "dotnet test" }),
    toolOk("t5", { shellExecution: { exitCode: 0 } }),
    assistant("Fixed the redirect loop by short-circuiting before the token check.", "2026-10-28T10:05:00.000Z"),
  ];
}
