#!/usr/bin/env node
/**
 * Copilot CLI / VS Code `userPromptTransformed` hook — pali (memory-mcp)
 * edition.
 *
 * Replaces the Hindsight version. Copilot's hook replaces model-facing prompt
 * content rather than appending to it, so the recalled memories are appended to
 * `transformedPrompt` and the result is returned as `modifiedTransformedPrompt`.
 * Memories already injected into this session (by SessionStart or an earlier
 * prompt) are skipped.
 *
 * Input  (stdin) : { sessionId, cwd, prompt, transformedPrompt }
 * Output (stdout): { modifiedTransformedPrompt } — nothing when there is nothing
 *                  relevant to inject.
 */

import {
  formatMemoryBlock,
  hookConfig,
  loadInjected,
  log,
  projectScope,
  recallMemories,
  readHookEvent,
  recordInjected,
  runHook,
} from "./pali-client.mjs";

runHook("prompt", async () => {
  const config = hookConfig();
  if (config.disabled) return "";

  const event = readHookEvent();
  if (!event) return "";

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
    typeof event.transformedPrompt === "string" && event.transformedPrompt
      ? event.transformedPrompt
      : prompt;
  log("info", `prompt ${scope}: injected ${memories.length} memories`);
  return JSON.stringify({ modifiedTransformedPrompt: `${base}\n\n${block}`.trim() });
});
