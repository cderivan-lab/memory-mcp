#!/usr/bin/env node
/**
 * Copilot CLI / VS Code `agentStop` hook — pali (memory-mcp) edition.
 *
 * Pali stores markdown verbatim, so this hook captures a
 * compact, deterministic digest of the session instead: what was asked, which
 * files were modified, which commands ran, what failed, and how it ended. The
 * memory is upserted (same name per session per day) and skipped entirely when
 * the digest has not changed, so repeated `agentStop` events do not create
 * duplicate commits.
 *
 * Input  (stdin) : { sessionId, cwd, transcriptPath }
 * Output (stdout): nothing — capture is silent and best effort.
 *
 * Set PALI_HOOK_CAPTURE=0 to disable capture and PALI_HOOK_KEEP_SESSIONS=0 to
 * keep every captured session instead of retaining the newest 20 per project.
 */

import { log, hookConfig, projectScope, readHookEvent, runHook } from "./pali-client.mjs";
import { captureSession, pruneCapturedSessions } from "./pali-session-capture.mjs";
import { hasContent, readTranscript } from "./pali-session-digest.mjs";

runHook("agentStop", async () => {
  const config = hookConfig();
  if (config.disabled || !config.capture) return "";

  const event = readHookEvent();
  if (!event) return "";

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
  const result = await captureSession(session, { cwd, scope, sessionId, transcriptPath, config });

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
      await pruneCapturedSessions({
        scope,
        keep: config.keepSessions,
        config,
        protect: [result.name],
      });
    } catch (error) {
      log("warn", `agentStop ${scope}: prune failed`, { error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return "";
});
