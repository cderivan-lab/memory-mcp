#!/usr/bin/env node
/**
 * Copilot CLI / VS Code hooks for pali (memory-mcp) — one entry point for the
 * three hook events.
 *
 * Configure the same command for `sessionStart`, `userPromptTransformed`, and
 * `agentStop`; the event is inferred from the payload, or passed explicitly as
 * the first argument (`session-start`, `prompt`, `stop`).
 *
 *   sessionStart          recall project memories into `additionalContext`
 *   userPromptTransformed recall memories relevant to the prompt into
 *                         `modifiedTransformedPrompt`
 *   agentStop             capture a deterministic digest of the session, then
 *                         retain the newest PALI_HOOK_KEEP_SESSIONS per project
 *
 * Input  (stdin) : the hook event JSON.
 * Output (stdout): the host's expected JSON, or nothing.
 *
 * Set PALI_HOOK_DISABLE=1 to disable every hook, PALI_HOOK_CAPTURE=0 to skip
 * session capture, and PALI_HOOK_KEEP_SESSIONS=0 to keep every captured
 * session instead of retaining the newest 20 per project.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  callTool,
  deleteStateFile,
  formatMemoryBlock,
  hookConfig,
  loadInjected,
  log,
  projectScope,
  recallMemories,
  readHookEvent,
  readStateFile,
  recordInjected,
  runHook,
  sha256,
  stripMemoryBlocks,
  writeStateFile,
} from "./pali-client.mjs";

// ---------------------------------------------------------------------------
// Session digest
//
// pali stores markdown verbatim and has no server-side LLM extraction step, so
// a capture is a compact summary computed from the transcript itself: what was
// asked, which files were modified, which commands ran, what failed, and how
// the session ended. Pure functions only — file reads aside, nothing here
// touches the network or the memory store, which keeps it testable.
//
// Transcript events used:
//   user.message / assistant.message  -> data.content
//   tool.execution_start              -> data.toolName, data.arguments, data.toolCallId
//   tool.execution_complete           -> data.toolCallId, data.success, data.error,
//                                       data.shellExecution.exitCode
// ---------------------------------------------------------------------------

const LIMITS = {
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

function collapse(text) {
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
function readTranscript(path) {
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

function collectFiles(tools, cwd) {
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
function collectCommands(tools) {
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
function collectFailures(tools) {
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

function toolActivity(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LIMITS.toolNames)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
}

/** A session worth capturing: at least one request, or any tool activity at all. */
function hasContent(session) {
  return Boolean(session?.turns?.length || session?.tools?.length);
}

/**
 * Render the memory body. Returns null when the transcript has no user request:
 * a memory with no question in it is not worth an embedding.
 */
function sessionName({ day, sessionId, transcriptPath }) {
  const suffix =
    String(sessionId ?? "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 40) || sha256(String(transcriptPath ?? "unknown")).slice(0, 12);
  return `copilot-session-${day}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Session capture and retention
// ---------------------------------------------------------------------------

const SESSION_TAGS = ["session", "auto-capture", "harness:copilot-cli"];
const SESSION_TAG = "auto-capture";
const NAME_PREFIX = "copilot-session-";
const LIST_PAGE = 100;

function stateFileOf(name) {
  return `stop/${name}.json`;
}

/**
 * Write the digest for one session unless it is byte-identical to what is
 * already stored. A repeat `agentStop` on an unchanged session therefore
 * creates no commit.
 */
async function captureSession(session, { cwd, scope, sessionId, config }) {
  const content = buildDigest(session, { scope, sessionId, cwd });
  if (!content) return { written: false, reason: "empty" };

  const day = dayOf(session.turns);
  const name = sessionName({ day, sessionId });
  const hash = sha256(content);
  const stateFile = stateFileOf(name);
  if (readStateFile(stateFile)?.hash === hash) return { written: false, reason: "unchanged", name };

  await callTool(
    "note",
    { name, content, scope, tags: SESSION_TAGS, source: "copilot-stop-hook" },
    { timeoutMs: 25000, config },
  );
  writeStateFile(stateFile, { hash, scope, capturedAt: new Date().toISOString() });
  return { written: true, name, day, content };
}

/**
 * Keep the newest `keep` captured sessions in `scope`; forget the rest.
 *
 * Retention is what stops one memory per session from swamping a project's
 * scope. Only this hook's own memories are eligible: the `auto-capture` tag
 * plus the `copilot-session-` name prefix. `protect` names are never deleted,
 * which covers the session captured moments ago in the same process.
 */
async function pruneCapturedSessions({ scope, keep, config, protect = [], dryRun = false }) {
  if (!keep || keep < 1) return { forgotten: [], total: 0, kept: 0 };

  let response;
  try {
    response = await callTool(
      "list",
      { scope, tags_all: [SESSION_TAG], limit: LIST_PAGE },
      { timeoutMs: 20000, config },
    );
  } catch (error) {
    log("warn", `prune ${scope}: list failed`, { error: String(error?.message ?? error).slice(0, 200) });
    return { forgotten: [], total: 0, kept: 0 };
  }

  // A scoped list also returns global memories; only this scope's own captures
  // are candidates, or `forget` would be handed a name it cannot resolve.
  const captured = (Array.isArray(response?.memories) ? response.memories : []).filter(
    (memory) =>
      typeof memory?.name === "string" &&
      memory.name.startsWith(NAME_PREFIX) &&
      (!memory.scope || memory.scope === scope),
  );
  if (response?.has_more) {
    log("warn", `prune ${scope}: more than ${LIST_PAGE} captured sessions, retaining only what was listed`);
  }

  const newestFirst = [...captured].sort(
    (a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || b.name.localeCompare(a.name),
  );
  const protectedNames = new Set(protect.filter(Boolean));
  const keepNames = new Set(newestFirst.slice(0, keep).map((memory) => memory.name));
  for (const name of protectedNames) keepNames.add(name);

  const doomed = newestFirst.filter((memory) => !keepNames.has(memory.name));
  const forgotten = [];
  for (const memory of doomed) {
    if (!dryRun) {
      try {
        await callTool("forget", { name: memory.name, scope }, { timeoutMs: 20000, config });
      } catch (error) {
        log("warn", `prune ${scope}: forget ${memory.name} failed`, {
          error: String(error?.message ?? error).slice(0, 200),
        });
        continue;
      }
      // A pruned session may be resumed later; without its state file the next
      // `agentStop` re-captures it instead of believing it is already stored.
      deleteStateFile(stateFileOf(memory.name));
    }
    forgotten.push(memory.name);
  }

  if (forgotten.length) {
    log("info", `prune ${scope}: ${dryRun ? "would forget" : "forgot"} ${forgotten.length} old session(s)`, {
      kept: Math.min(keep, captured.length),
      forgotten: forgotten.slice(0, 5),
    });
  }
  return { forgotten, total: captured.length, kept: Math.max(0, captured.length - forgotten.length) };
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

const recallQuery = (scope) =>
  `${scope}: project overview, purpose, architecture, conventions, build and test commands, key decisions, known gotchas`;

async function sessionStart(event, config) {
  if (config.disabled) return "";

  const cwd = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
  const scope = projectScope(cwd, config);
  const memories = await recallMemories(recallQuery(scope), {
    scope,
    limit: 6,
    // Session start is project-scoped already: breadth beats a distance cut.
    maxDistance: 0,
    timeoutMs: 15000,
    config,
  });
  if (!memories.length) {
    log("debug", `sessionStart ${scope}: no memories`);
    return "";
  }

  recordInjected(event.sessionId, memories.map((memory) => memory.name));
  const block = formatMemoryBlock({
    scope,
    memories,
    intro: `Project memories from the pali memory-mcp store (scope "${scope}"), recalled at session start:`,
    budget: 6000,
  });
  log("info", `sessionStart ${scope}: injected ${memories.length} memories`);
  return JSON.stringify({ additionalContext: block });
}

async function userPromptTransformed(event, config) {
  if (config.disabled) return "";

  const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
  // Slash commands and one-word prompts carry no retrieval signal.
  if (prompt.length < 8 || /^[/!]/.test(prompt)) return "";

  const cwd = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
  const scope = projectScope(cwd, config);
  const injected = loadInjected(event.sessionId);

  const recalled = await recallMemories(prompt, {
    scope,
    limit: 5,
    timeoutMs: 12000,
    config,
  });
  const memories = recalled.filter((memory) => !injected[memory.name]);
  if (!memories.length) {
    log("debug", `prompt ${scope}: nothing new to inject (${recalled.length} recalled)`);
    return "";
  }

  const block = formatMemoryBlock({
    scope,
    memories,
    intro: `Memories relevant to this request, from the pali memory-mcp store (scope "${scope}"):`,
    budget: 2500,
  });
  if (!block) return "";

  recordInjected(event.sessionId, memories.map((memory) => memory.name));
  const base =
    typeof event.transformedPrompt === "string" && event.transformedPrompt ? event.transformedPrompt : prompt;
  log("info", `prompt ${scope}: injected ${memories.length} memories`);
  return JSON.stringify({ modifiedTransformedPrompt: `${base}\n\n${block}`.trim() });
}

async function agentStop(event, config) {
  if (config.disabled || !config.capture) return "";

  const transcriptPath = typeof event.transcriptPath === "string" ? event.transcriptPath : "";
  if (!transcriptPath) {
    log("debug", "agentStop: no transcriptPath in event");
    return "";
  }

  const cwd = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
  const session = readTranscript(transcriptPath);
  if (!hasContent(session)) {
    log("debug", "agentStop: transcript too short to capture", { turns: session.turns.length });
    return "";
  }

  const scope = projectScope(cwd, config);
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
  const result = await captureSession(session, { cwd, scope, sessionId, config });

  if (!result.written) {
    log("debug", `agentStop ${scope}: ${result.name ?? "session"} ${result.reason}, skipping`);
    return "";
  }
  log("info", `agentStop ${scope}: captured ${result.name}`, {
    turns: session.turns.length,
    tools: session.tools.length,
  });

  // Retention runs only after a write: the count can only have grown here.
  if (config.keepSessions > 0) {
    try {
      await pruneCapturedSessions({ scope, keep: config.keepSessions, config, protect: [result.name] });
    } catch (error) {
      log("warn", `agentStop ${scope}: prune failed`, { error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const MODES = {
  "session-start": "sessionStart",
  sessionstart: "sessionStart",
  prompt: "prompt",
  "user-prompt": "prompt",
  stop: "agentStop",
  "agent-stop": "agentStop",
  agentstop: "agentStop",
};

const HANDLERS = {
  sessionStart,
  prompt: userPromptTransformed,
  agentStop,
};

/** The three payloads are distinguishable: only the stop event names a transcript. */
function detectMode(event) {
  if (typeof event.prompt === "string") return "prompt";
  if (typeof event.transcriptPath === "string" && event.transcriptPath) return "agentStop";
  return "sessionStart";
}

const event = readHookEvent();
if (event) {
  const requested = MODES[String(process.argv[2] ?? "").toLowerCase()];
  const mode = requested ?? detectMode(event);
  await runHook(mode, () => HANDLERS[mode](event, hookConfig()));
}
