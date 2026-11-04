# Tasks: Copilot session capture hooks

Implemented in commits `70577cd`–`b5a9c11`; tasks record the delivered
slices.

## 1. Transport and dispatcher

- [x] 1.1 `hooks/pali-client.mjs`: short-lived `pali serve` stdio spawn,
      MCP handshake, single `tools/call`, never throws; 0600 log files
- [x] 1.2 `hooks/copilot-hooks.mjs`: one entry for `sessionStart`,
      `userPromptTransformed`, `agentStop` with event inference
- [x] 1.3 Environment kill switches: `PALI_HOOK_DISABLE`,
      `PALI_HOOK_CAPTURE`, `PALI_HOOK_KEEP_SESSIONS`,
      `PALI_HOOK_LOG_LEVEL` (mirrors `pali.logLevel`)

## 2. Recall paths

- [x] 2.1 `sessionStart` → project-scope recall into `additionalContext`
      with per-session injection tracking
- [x] 2.2 `userPromptTransformed` → prompt-relevant recall into
      `modifiedTransformedPrompt`, unchanged on empty/failed recall

## 3. Capture path

- [x] 3.1 Deterministic transcript digest (requests, files, commands,
      failures, ending; front-trimmed to keep the final state)
- [x] 3.2 `copilot-session-<day>-<id>` memories tagged
      `session/auto-capture/harness:copilot-cli`; no rewrite when content is
      byte-identical; empty sessions skipped
- [x] 3.3 Per-project retention of newest `PALI_HOOK_KEEP_SESSIONS`
      (default 20; 0 disables pruning)
- [x] 3.4 `hooks/backfill-sessions.mjs` to import existing transcripts

## 4. Install / uninstall lifecycle

- [x] 4.1 Extension writes `~/.copilot/hooks/pali.json` (idempotent,
      `PALI_HOOKS_DIR` override, warning on write failure)
- [x] 4.2 `src/uninstall.ts`: delete the hooks file only when it is wholly
      pali-owned (entries reference `copilot-hooks.mjs`); missing file OK

## 5. Verification

- [x] 5.1 Hook test suite under `hooks/test/` (digest, stop hook, backfill,
      stubbed pali)
- [ ] 5.2 Record a hooks test-run receipt (and `npm test` for extension
      tests) in the PR description
