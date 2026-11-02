/**
 * Session capture for pali: write (or refresh) one memory per Copilot session,
 * and keep the number of auto-captured sessions per project bounded.
 *
 * Shared by the `agentStop` hook and the backfill CLI, so both produce
 * identical names, tags and content for the same transcript.
 */

import { buildDigest, dayOf, sessionName } from "./pali-session-digest.mjs";
import {
  callTool,
  deleteStateFile,
  log,
  readStateFile,
  sha256,
  writeStateFile,
} from "./pali-client.mjs";

export const SESSION_TAGS = ["session", "auto-capture", "harness:copilot-cli"];
const SESSION_TAG = "auto-capture";
const NAME_PREFIX = "copilot-session-";
const LIST_PAGE = 100;

function stateFileOf(name) {
  return `stop/${name}.json`;
}

/**
 * Write the digest for one session unless it is byte-identical to what is
 * already stored. Returns `{ written, name, reason }`; a repeat `agentStop` on
 * an unchanged session therefore creates no commit.
 */
export async function captureSession(session, { cwd, scope, sessionId, transcriptPath, config, source = "copilot-stop-hook" }) {
  const content = buildDigest(session, { scope, sessionId, cwd });
  if (!content) return { written: false, reason: "empty" };

  const day = dayOf(session.turns);
  const name = sessionName({ day, sessionId, transcriptPath });
  const hash = sha256(content);
  const stateFile = stateFileOf(name);
  if (readStateFile(stateFile)?.hash === hash) return { written: false, reason: "unchanged", name };

  await callTool(
    "note",
    { name, content, scope, tags: SESSION_TAGS, source },
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
export async function pruneCapturedSessions({ scope, keep, config, protect = [], dryRun = false }) {
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
