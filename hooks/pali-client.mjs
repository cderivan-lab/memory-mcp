/**
 * Shared plumbing for the Copilot hooks that talk to the pali memory-mcp server.
 *
 * pali speaks MCP over stdio, so every hook starts a short-lived `pali serve`
 * process, performs the handshake, issues exactly one `tools/call`, and exits.
 * Stdio is the only transport pali speaks (the `--transport` flag was removed
 * in pali 1.0.1 — see ADR-0050). Hooks are best effort: nothing in here may throw
 * into the host agent, so `runHook` swallows and logs every failure.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const STATE_DIR = process.env.PALI_HOOK_STATE_DIR || join(homedir(), ".pali-hooks");
const LOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const SESSION_STATE_TTL_MS = 12 * 60 * 60 * 1000;
const MEMORY_OPEN = "<pali_memory>";
const MEMORY_CLOSE = "</pali_memory>";

const MEMORY_BLOCK_RE = /<pali_memory>[\s\S]*?<\/pali_memory>/g;
const LOG_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function hookConfig() {
  const env = process.env;
  const rawDistance = (env.PALI_RECALL_MAX_DISTANCE ?? "").trim();
  const distance = rawDistance ? Number(rawDistance) : Number.NaN;
  const rawKeep = (env.PALI_HOOK_KEEP_SESSIONS ?? "").trim();
  const keep = rawKeep ? Number(rawKeep) : Number.NaN;
  return {
    bin: env.PALI_BIN || "pali",
    repoPath: env.PALI_REPO_PATH || "",
    scope: env.PALI_SCOPE || "",
    capture: !/^(0|false|no|off)$/i.test(String(env.PALI_HOOK_CAPTURE ?? "").trim()),
    disabled: truthy(env.PALI_HOOK_DISABLE),
    maxDistance: Number.isFinite(distance) ? distance : 0.45,
    // Captured sessions retained per project scope; 0 disables pruning.
    keepSessions: Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : 20,
    logLevel: (env.PALI_HOOK_LOG_LEVEL || "info").toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logFile() {
  return process.env.PALI_HOOK_LOG_FILE || join(STATE_DIR, "hook.log");
}

export function log(level, message, extra) {
  const configured = hookConfig().logLevel;
  const threshold = LOG_WEIGHT[configured] ?? LOG_WEIGHT.info;
  if ((LOG_WEIGHT[level] ?? 20) < threshold) return;
  try {
    const file = logFile();
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    try {
      if (statSync(file).size >= LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch { }
    const detail = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
    appendFileSync(
      file,
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${detail}\n`,
      {
        mode: 0o600,
      },
    );
  } catch { }
}

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 300);
}

// ---------------------------------------------------------------------------
// Hook input / output
// ---------------------------------------------------------------------------

/** Read the hook event JSON from stdin. Returns null for empty or malformed input. */
export function readHookEvent() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return null;
  try {
    const event = JSON.parse(text);
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  } catch {
    return null;
  }
}

/**
 * Run one hook body and write its output. `fn` returns the JSON string the host
 * expects, or "" for silence. Errors are logged, never surfaced: a broken hook
 * must not break the agent session.
 */
export async function runHook(name, fn) {
  try {
    const output = await fn();
    if (typeof output === "string" && output) process.stdout.write(output);
  } catch (error) {
    log("warn", `${name}: hook failed`, { error: describeError(error) });
  }
}

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------

function sanitizeComponent(component) {
  return component
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.]+/, "_")
    .replace(/^-+|-+$/g, "");
}

/** pali scopes are namespace paths: alphanumeric, '-', '_' and '.' per component. */
export function sanitizeScope(value) {
  const components = String(value || "")
    .split("/")
    .map(sanitizeComponent)
    .filter(Boolean)
    .slice(0, 10);
  return components.length ? components.join("/") : "unknown-project";
}

/** The git project name, else the cwd name. */
export function projectScope(cwd, config = hookConfig()) {
  if (config.scope) return sanitizeScope(config.scope);
  let name = "";
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) name = basename(top);
  } catch { }
  if (!name) name = basename(cwd || process.cwd());
  return sanitizeScope(name);
}

// ---------------------------------------------------------------------------
// MCP over stdio
// ---------------------------------------------------------------------------

function unwrapResult(tool, message) {
  if (message.error) {
    throw new Error(`pali ${tool}: ${message.error.message || JSON.stringify(message.error)}`);
  }
  const result = message.result;
  if (!result) throw new Error(`pali ${tool}: empty result`);
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) throw new Error(`pali ${tool}: ${text || "tool reported an error"}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Call one pali tool. The server is started local-only: hooks never pass
 * `--remote-url`, so a slow or offline git remote can never stall a hook. The
 * long-running MCP server (which does own the remote) picks the commit up on
 * its next pull/push.
 *
 * Stdio is the only transport pali speaks, so `serve` is invoked with no
 * transport flag. (pali 1.0.1 removed the `--transport` argument along with the
 * Streamable HTTP client — see ADR-0050.)
 */
export function callTool(name, args, options = {}) {
  const config = options.config || hookConfig();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const argv = ["serve"];
    if (config.repoPath) argv.push("--repo-path", config.repoPath);

    let child;
    try {
      child = spawn(config.bin, argv, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    } catch (error) {
      reject(new Error(`cannot start ${config.bin}: ${describeError(error)}`));
      return;
    }

    let settled = false;
    let buffer = "";
    let stderrTail = "";
    let timer;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } catch { }
      try {
        child.kill("SIGTERM");
      } catch { }
      const reap = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { }
      }, 2000);
      if (typeof reap.unref === "function") reap.unref();
      settle(value);
    };

    timer = setTimeout(
      () => finish(reject, new Error(`pali ${name} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    child.on("error", (error) =>
      finish(reject, new Error(`cannot start ${config.bin}: ${describeError(error)}`)),
    );
    child.on("exit", (code) =>
      finish(
        reject,
        new Error(`pali exited (code ${code}) before replying: ${stderrTail.trim().slice(-300)}`),
      ),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
    child.stdin.on("error", () => { });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        finish(reject, new Error(`pali ${name}: response exceeded 4MB`));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        try {
          finish(resolve, unwrapResult(name, message));
        } catch (error) {
          finish(reject, error);
        }
        return;
      }
    });

    const frames = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "pali-copilot-hook", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    ];
    child.stdin.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  });
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Hybrid recall, keeping snippets close enough to matter. Lexical-only hits
 * carry pali's -1.0 sentinel distance and always pass. Set
 * PALI_RECALL_MAX_DISTANCE=0 to keep every ranked hit.
 */
export async function recallMemories(query, options = {}) {
  const config = options.config || hookConfig();
  const limit = options.limit ?? 5;
  const maxDistance = options.maxDistance ?? config.maxDistance;
  const scope = options.scope;
  const response = await callTool(
    "recall",
    { query: String(query).slice(0, 1200), scope, limit },
    { timeoutMs: options.timeoutMs, config },
  );
  const results = Array.isArray(response?.results) ? response.results : [];
  const useful = results.filter((memory) => {
    if (!(maxDistance > 0)) return true;
    const distance = memory?.distance;
    if (typeof distance !== "number") return true;
    return distance < 0 || distance <= maxDistance;
  });
  return useful.filter((memory) => typeof memory?.name === "string" && memory.name).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Per-session de-duplication
// ---------------------------------------------------------------------------

function sessionStateFile(sessionId) {
  const safe = String(sessionId || "no-session")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 80);
  return join(STATE_DIR, "sessions", `session-${safe}.json`);
}

/** Memory names already injected into this session, name -> first injection time. */
export function loadInjected(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(sessionStateFile(sessionId), "utf8"));
    const injected =
      parsed && typeof parsed.injected === "object" && parsed.injected ? parsed.injected : {};
    const cutoff = Date.now() - SESSION_STATE_TTL_MS;
    const fresh = {};
    for (const [name, at] of Object.entries(injected)) {
      if (typeof at === "number" && at >= cutoff) fresh[name] = at;
    }
    return fresh;
  } catch {
    return {};
  }
}

export function recordInjected(sessionId, names) {
  if (!Array.isArray(names) || !names.length) return;
  const injected = loadInjected(sessionId);
  const now = Date.now();
  for (const name of names)
    if (typeof name === "string" && name) injected[name] = injected[name] ?? now;
  const trimmed = Object.fromEntries(Object.entries(injected).slice(-200));
  try {
    mkdirSync(join(STATE_DIR, "sessions"), { recursive: true, mode: 0o700 });
    writeFileSync(sessionStateFile(sessionId), JSON.stringify({ injected: trimmed }), {
      mode: 0o600,
    });
  } catch { }
}

// ---------------------------------------------------------------------------
// Injection block
// ---------------------------------------------------------------------------

export function stripMemoryBlocks(text) {
  return String(text ?? "").replace(MEMORY_BLOCK_RE, "");
}

/**
 * Render recalled memories as one model-facing block. `budget` bounds the
 * characters spent on memory so a prompt never balloons.
 */
export function formatMemoryBlock({ scope, memories, intro, budget = 6000 }) {
  if (!Array.isArray(memories) || !memories.length) return "";

  const head = intro || `Memories recalled from the pali memory-mcp store (scope "${scope}"):`;
  const footer =
    `Full text for any entry: \`read\` with its name and scope "${scope}". ` +
    `Search for more with \`recall\`; record durable findings with \`note\` in the same scope.`;

  const kept = [];
  let used = head.length + footer.length;
  let omitted = 0;
  for (const memory of memories) {
    const content = String(memory.content ?? "").trim();
    const tags = Array.isArray(memory.tags)
      ? memory.tags
        .filter((tag) => typeof tag === "string" && !tag.startsWith("source-sha:"))
        .slice(0, 6)
      : [];
    const lines = [`### ${memory.name}`];
    if (content) lines.push(content);
    if (memory.truncated)
      lines.push(`_(snippet truncated at ${memory.content_length ?? "?"} chars)_`);
    if (tags.length) lines.push(`tags: ${tags.join(", ")}`);
    const rendered = lines.join("\n");
    if (kept.length && used + rendered.length > budget) {
      omitted += 1;
      continue;
    }
    kept.push(rendered);
    used += rendered.length;
  }

  if (!kept.length) return "";
  if (omitted) kept.push(`_(${omitted} more recalled memories omitted for length)_`);
  return [MEMORY_OPEN, head, kept.join("\n\n"), footer, MEMORY_CLOSE].join("\n");
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/** Stable short key for filenames when a session id is missing. */
export function shortKey(value) {
  return sha256(value).slice(0, 12);
}

export function writeStateFile(relative, data) {
  const file = join(STATE_DIR, relative);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function readStateFile(relative) {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, relative), "utf8"));
  } catch {
    return null;
  }
}

export function deleteStateFile(relative) {
  try {
    unlinkSync(join(STATE_DIR, relative));
    return true;
  } catch {
    return false;
  }
}
