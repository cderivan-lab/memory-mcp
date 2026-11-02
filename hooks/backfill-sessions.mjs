#!/usr/bin/env node
/**
 * Backfill past VS Code / Copilot CLI sessions into pali memory.
 *
 * The `agentStop` hook only sees sessions from the moment it is installed, so
 * this walks the sessions Copilot has already recorded and captures each one
 * with the same digest, name and tags the hook would have used. Re-running is
 * cheap: a session whose transcript has not changed is skipped.
 *
 * Usage:
 *   node backfill-sessions.mjs --dry-run     # show what would be captured
 *   node backfill-sessions.mjs               # capture, then apply retention
 *   node backfill-sessions.mjs --keep 0      # capture everything, prune nothing
 *
 * Options:
 *   --dry-run              Build digests and report, write nothing.
 *   --sessions-dir <path>  Copilot session-state directory (default ~/.copilot/session-state).
 *   --keep <n>             Captured sessions retained per project (default PALI_HOOK_KEEP_SESSIONS or 20; 0 = all).
 *   --since <YYYY-MM-DD>   Ignore sessions whose first message is older.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hookConfig, log, projectScope } from "./pali-client.mjs";
import { captureSession, pruneCapturedSessions } from "./pali-session-capture.mjs";
import { buildDigest, dayOf, hasContent, readTranscript } from "./pali-session-digest.mjs";

function parseArgs(argv) {
  const options = { dryRun: false, sessionsDir: "", keep: undefined, since: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--sessions-dir":
        options.sessionsDir = argv[++index] ?? "";
        break;
      case "--keep":
        options.keep = Number(argv[++index] ?? "");
        break;
      case "--since":
        options.since = argv[++index] ?? "";
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--sessions-dir=")) options.sessionsDir = arg.slice("--sessions-dir=".length);
        else if (arg.startsWith("--keep=")) options.keep = Number(arg.slice("--keep=".length));
        else if (arg.startsWith("--since=")) options.since = arg.slice("--since=".length);
        else throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Minimal reader for the handful of scalar keys Copilot writes to workspace.yaml. */
function readWorkspace(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, "workspace.yaml"), "utf8");
  } catch {
    return {};
  }
  const field = (key) => {
    const match = raw.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    const value = match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
    // `name: |-` is the start of a YAML block scalar, not a usable label.
    return /^[|>][+-]?\d*$/.test(value) ? "" : value;
  };
  return {
    cwd: field("cwd"),
    name: field("name"),
    created_at: field("created_at"),
    updated_at: field("updated_at"),
  };
}

function listSessionDirs(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read ${root}: ${error.message}`);
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const transcriptPath = join(dir, "events.jsonl");
    try {
      if (!statSync(transcriptPath).isFile()) continue;
    } catch {
      continue;
    }
    const workspace = readWorkspace(dir);
    sessions.push({ sessionId: entry.name, dir, transcriptPath, workspace });
  }
  // Oldest first, so the newest sessions are the ones retention keeps.
  sessions.sort((a, b) =>
    String(a.workspace.created_at).localeCompare(String(b.workspace.created_at)) || a.sessionId.localeCompare(b.sessionId),
  );
  return sessions;
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "").trim());
    return;
  }

  const config = hookConfig();
  const keep = Number.isFinite(options.keep) && options.keep !== undefined ? Math.max(0, Math.floor(options.keep)) : config.keepSessions;
  const root = options.sessionsDir || join(homedir(), ".copilot", "session-state");
  const started = Date.now();

  const sessions = listSessionDirs(root);
  console.log(
    `${options.dryRun ? "Dry run — " : ""}${sessions.length} session transcript(s) under ${root}; retaining ${keep > 0 ? `newest ${keep} per project` : "all sessions"}.`,
  );

  const stats = { captured: 0, unchanged: 0, empty: 0, tooOld: 0, failed: 0 };
  const scopes = new Set();

  for (const session of sessions) {
    const transcript = readTranscript(session.transcriptPath);
    const label = session.workspace.name ? `${session.sessionId.slice(0, 8)} "${session.workspace.name.slice(0, 50)}"` : session.sessionId.slice(0, 8);

    if (!hasContent(transcript)) {
      stats.empty += 1;
      console.log(`  skip  ${label}: empty transcript`);
      continue;
    }

    const day = dayOf(transcript.turns);
    if (options.since && day < options.since) {
      stats.tooOld += 1;
      continue;
    }

    const cwd = session.workspace.cwd || homedir();
    const scope = projectScope(cwd, config);
    scopes.add(scope);

    if (options.dryRun) {
      const content = buildDigest(transcript, { scope, sessionId: session.sessionId, cwd });
      if (!content) {
        stats.empty += 1;
        console.log(`  skip  ${label}: no user request`);
        continue;
      }
      console.log(
        `  plan  ${label} -> ${scope} (${day}, ${transcript.tools.length} tool calls, ${content.length} chars)`,
      );
      stats.captured += 1;
      continue;
    }

    try {
      const result = await captureSession(transcript, {
        cwd,
        scope,
        sessionId: session.sessionId,
        transcriptPath: session.transcriptPath,
        config,
        source: "copilot-backfill",
      });
      if (result.written) {
        stats.captured += 1;
        console.log(`  new   ${label} -> ${scope} (${day}, ${transcript.tools.length} tool calls)`);
      } else if (result.reason === "unchanged") {
        stats.unchanged += 1;
        console.log(`  same  ${label} -> ${scope}`);
      } else {
        stats.empty += 1;
        console.log(`  skip  ${label}: no user request`);
      }
    } catch (error) {
      stats.failed += 1;
      console.log(`  fail  ${label}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
    }
  }

  if (keep > 0 && !options.dryRun) {
    for (const scope of scopes) {
      try {
        // No `protect`: retention applies to the freshly written sessions too,
        // which is the point of a backfill followed by a cap.
        const result = await pruneCapturedSessions({ scope, keep, config });
        if (result.forgotten.length) {
          console.log(`  prune ${scope}: forgot ${result.forgotten.length} old session(s), keeping ${result.kept}`);
        }
      } catch (error) {
        console.log(`  prune ${scope}: failed — ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
      }
    }
  }

  const verb = options.dryRun ? "would capture" : "captured";
  console.log(
    `\n${verb} ${stats.captured}, unchanged ${stats.unchanged}, empty ${stats.empty}, too old ${stats.tooOld}, failed ${stats.failed} in ${formatDuration(Date.now() - started)}.`,
  );
  if (stats.captured && !options.dryRun) {
    console.log("Restart the pali MCP server (or VS Code) so the new memories enter the in-session index.");
  }
}

main().catch((error) => {
  log("error", "backfill failed", { error: String(error?.message ?? error).slice(0, 300) });
  console.error(`backfill failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
