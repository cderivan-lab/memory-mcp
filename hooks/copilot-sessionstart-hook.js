#!/usr/bin/env node
/**
 * Copilot CLI / VS Code SessionStart hook — pali (memory-mcp) edition.
 *
 * Replaces the Hindsight version: instead of asking a Hindsight bank for
 * curated knowledge pages, it recalls the project's memories straight from the
 * pali store (scope = git project name) and injects them as additionalContext.
 *
 * Input  (stdin) : { sessionId, cwd }
 * Output (stdout): { additionalContext } — nothing when there is no memory.
 */

import {
  formatMemoryBlock,
  hookConfig,
  log,
  projectScope,
  recallMemories,
  readHookEvent,
  recordInjected,
  runHook,
} from "./pali-client.mjs";

const recallQuery = (scope) =>
  `${scope}: project overview, purpose, architecture, conventions, build and test commands, key decisions, known gotchas`;

runHook("sessionStart", async () => {
  const config = hookConfig();
  if (config.disabled) return "";

  const event = readHookEvent();
  if (!event) return "";

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
});
