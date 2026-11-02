/**
 * Deterministic digest of a VS Code / Copilot CLI session transcript.
 *
 * pali stores markdown verbatim and has no server-side LLM extraction step, so
 * a capture is a compact summary computed from the transcript itself: what was
 * asked, which files were modified, which commands ran, what failed, and how
 * the session ended. Pure functions only — file reads aside, nothing here
 * touches the network or the memory store, which keeps it testable.
 *
 * Transcript events used:
 *   user.message / assistant.message  -> data.content
 *   tool.execution_start             -> data.toolName, data.arguments, data.toolCallId
 *   tool.execution_complete          -> data.toolCallId, data.success, data.error,
 *                                       data.shellExecution.exitCode
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { sha256, stripMemoryBlocks } from "./pali-client.mjs";

export const LIMITS = {
  transcriptBytes: 32 * 1024 * 1024,
  requests: 10,
  requestChars: 400,
  outcomeChars: 3000,
  files: 40,
  fileChars: 200,
  commands: 12,
  commandChars: 200,
  failures: 5,
  failureChars: 300,
  toolNames: 8,
  contentChars: 16000,
};

// Tools whose call mutates a file. `new_str`/`file_text` arguments also mark a
// call as a write, which covers aliases shipped by other Copilot builds.
const WRITE_TOOLS = new Set([
  "edit",
  "create",
  "write",
  "apply_patch",
  "multiedit",
  "multi_edit",
  "str_replace",
  "replace",
  "insert",
  "notebook_edit",
  "delete_file",
  "remove_file",
]);
const PATH_KEYS = ["path", "file_path", "filePath", "notebook_path", "target_file"];
const WRITE_ARG_HINTS = ["new_str", "new_string", "file_text", "fileText", "content"];

export function collapse(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function relativeTo(cwd, value) {
  const raw = String(value ?? "").trim();
  if (!raw || !isAbsolute(raw) || !cwd) return raw;
  const rel = relative(cwd, raw);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : raw;
}

function writeTarget(toolName, args) {
  if (!args || typeof args !== "object") return "";
  const name = String(toolName ?? "").toLowerCase();
  const writeish =
    WRITE_TOOLS.has(name) || WRITE_ARG_HINTS.some((hint) => typeof args[hint] === "string" && args[hint].trim());
  if (!writeish) return "";
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function commandOf(args) {
  if (!args || typeof args !== "object") return "";
  const value = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
  return collapse(value).slice(0, LIMITS.commandChars);
}

/**
 * Read the transcript once, returning the conversation turns plus every tool
 * execution with its completion status. Tool result bodies are ignored: the
 * digest records what was done, not the output of everything that ran.
 */
export function readTranscript(path) {
  let raw;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > LIMITS.transcriptBytes) return { turns: [], tools: [] };
    raw = readFileSync(path, "utf8");
  } catch {
    return { turns: [], tools: [] };
  }

  const turns = [];
  const tools = [];
  const byCallId = new Map();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const data = event?.data;
    switch (event?.type) {
      case "user.message":
      case "assistant.message": {
        const content = typeof data?.content === "string" ? stripMemoryBlocks(data.content).trim() : "";
        if (content) {
          turns.push({
            role: event.type === "user.message" ? "user" : "assistant",
            content,
            timestamp: event.timestamp,
          });
        }
        break;
      }
      case "tool.execution_start": {
        const tool = {
          name: typeof data?.toolName === "string" ? data.toolName : "unknown",
          args: data?.arguments && typeof data.arguments === "object" ? data.arguments : {},
          succeeded: undefined,
          error: "",
          exitCode: undefined,
        };
        tools.push(tool);
        if (typeof data?.toolCallId === "string") byCallId.set(data.toolCallId, tool);
        break;
      }
      case "tool.execution_complete": {
        const tool = typeof data?.toolCallId === "string" ? byCallId.get(data.toolCallId) : undefined;
        if (!tool) break;
        tool.succeeded = data?.success !== false;
        tool.error = collapse(data?.error?.message).slice(0, LIMITS.failureChars);
        const exitCode = data?.shellExecution?.exitCode;
        if (typeof exitCode === "number") tool.exitCode = exitCode;
        break;
      }
      default:
        break;
    }
  }
  return { turns, tools };
}

export function dayOf(turns) {
  for (const turn of turns) {
    if (!turn.timestamp) continue;
    const date = new Date(turn.timestamp);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function gitContext(cwd) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && sha ? `${branch} @ ${sha}` : "";
  } catch {
    return "";
  }
}

export function collectFiles(tools, cwd) {
  const files = [];
  const seen = new Set();
  for (const tool of tools) {
    const target = writeTarget(tool.name, tool.args);
    if (!target) continue;
    const path = relativeTo(cwd, target).slice(0, LIMITS.fileChars);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
    if (files.length >= LIMITS.files) break;
  }
  return files;
}

// The most recent commands describe where the session ended up, so a long
// session is trimmed from the front rather than dropping its final state.
export function collectCommands(tools) {
  const commands = [];
  const seen = new Set();
  for (let index = tools.length - 1; index >= 0 && commands.length < LIMITS.commands; index -= 1) {
    const tool = tools[index];
    if (tool.succeeded === false) continue;
    const command = commandOf(tool.args);
    if (!command || seen.has(command)) continue;
    seen.add(command);
    commands.push(command);
  }
  return commands.reverse();
}

// Recent failures are the ones the session ended on, so they are what a later
// question about "what went wrong" is most likely to match.
export function collectFailures(tools) {
  const failures = [];
  const seen = new Set();
  for (let index = tools.length - 1; index >= 0 && failures.length < LIMITS.failures; index -= 1) {
    const tool = tools[index];
    const failed = tool.succeeded === false || (typeof tool.exitCode === "number" && tool.exitCode !== 0);
    if (!failed) continue;
    const command = commandOf(tool.args);
    const detail = [command ? `\`${command}\`` : "", tool.error].filter(Boolean).join(" — ") || "failed";
    const exit = typeof tool.exitCode === "number" ? ` (exit ${tool.exitCode})` : "";
    const line = `${tool.name}${exit}: ${collapse(detail).slice(0, LIMITS.failureChars)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    failures.push(line);
  }
  return failures.reverse();
}

export function toolActivity(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LIMITS.toolNames)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

/** A session worth capturing: at least one request, or any tool activity at all. */
export function hasContent(session) {
  return Boolean(session?.turns?.length || session?.tools?.length);
}

/**
 * Render the memory body. Returns null when the transcript has no user request:
 * a memory with no question in it is not worth an embedding.
 */
export function buildDigest({ turns, tools }, { scope, sessionId, cwd }) {
  const requests = [];
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const request = collapse(turn.content).slice(0, LIMITS.requestChars);
    if (!request) continue;
    if (requests[requests.length - 1] === request) continue;
    requests.push(request);
    if (requests.length >= LIMITS.requests) break;
  }
  if (!requests.length) return null;

  const finalMessage = [...turns].reverse().find((turn) => turn.role === "assistant");
  const outcome = finalMessage ? finalMessage.content.trim().slice(0, LIMITS.outcomeChars) : "";
  const userTurns = turns.filter((turn) => turn.role === "user").length;
  const assistantTurns = turns.length - userTurns;
  const git = gitContext(cwd);

  const lines = [
    `# Copilot session — ${scope} — ${dayOf(turns)}`,
    "",
    "Auto-captured from a VS Code / Copilot CLI session transcript when the agent stopped.",
    "",
    `- Harness: copilot-cli`,
    `- Scope: ${scope}`,
    `- Session: ${sessionId || "unknown"}`,
    `- Turns: ${userTurns} user / ${assistantTurns} assistant`,
    `- Tool calls: ${tools.length}`,
  ];
  if (git) lines.push(`- Checkout: ${git}`);

  lines.push("", "## Requests", "");
  requests.forEach((request, index) => lines.push(`${index + 1}. ${request}`));

  const files = collectFiles(tools, cwd);
  if (files.length) {
    lines.push("", "## Files modified", "");
    files.forEach((file) => lines.push(`- \`${file}\``));
  }

  const commands = collectCommands(tools);
  if (commands.length) {
    lines.push("", "## Commands run", "");
    commands.forEach((command, index) => lines.push(`${index + 1}. \`${command}\``));
  }

  const failures = collectFailures(tools);
  if (failures.length) {
    lines.push("", "## Failures", "");
    failures.forEach((failure) => lines.push(`- ${failure}`));
  }

  const activity = toolActivity(tools);
  if (activity) lines.push("", "## Tool activity", "", activity);

  if (outcome) lines.push("", "## Final assistant message", "", outcome);

  return lines.join("\n").slice(0, LIMITS.contentChars);
}

/** Stable memory name for one session, keyed by day + session id. */
export function sessionName({ day, sessionId, transcriptPath }) {
  const suffix =
    String(sessionId ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 40) || sha256(String(transcriptPath ?? "unknown")).slice(0, 12);
  return `copilot-session-${day}-${suffix}`;
}
