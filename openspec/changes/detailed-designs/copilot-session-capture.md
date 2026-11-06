# Detailed Design: Copilot Session Capture Hooks

## Change: add-copilot-session-capture

### Purpose

Close the loop between Copilot sessions and the memory store: recall project memories into fresh sessions and relevant memories into prompts, and capture finished sessions as deterministic digest memories — all best-effort so the coding host never blocks or fails because pali is unhealthy.

### New Capability: `copilot-session-capture`

#### Transport and Dispatcher

- **Single dispatcher** (`hooks/copilot-hooks.mjs`): serves all three hook events (`sessionStart`, `userPromptTransformed`, `agentStop`)
- Event inferred from stdin payload or explicit first argument
- Hook failure never propagates to host: on internal error, returns host's expected shape and exits successfully
- Environment kill switches: `PALI_HOOK_DISABLE`, `PALI_HOOK_CAPTURE`, `PALI_HOOK_KEEP_SESSIONS`, `PALI_HOOK_LOG_LEVEL`

#### Recall Paths

- **sessionStart**: Recalls project-scope memories into `additionalContext` with per-session injection tracking (prevents duplicate memory blocks on repeated starts)
- **userPromptTransformed**: Recalls prompt-relevant memories into `modifiedTransformedPrompt`; prompt unchanged when recall yields nothing or fails

#### Capture Path

- **Deterministic transcript digest**: Derived from requests, modified files, executed commands, failures, and how session ended
- Front-trimmed to keep the session's final state
- Memory naming: `copilot-session-<day>-<session-id>` tagged `session/auto-capture/harness:copilot-cli`
- No model call involved — transcript-derived only
- Byte-identical to stored memory — should NOT be rewritten
- Empty sessions (no requests, no tool activity) are skipped

#### Per-Project Retention

- Retains newest `PALI_HOOK_KEEP_SESSIONS` session memories per project scope (default 20)
- `PALI_HOOK_KEEP_SESSIONS=0` disables pruning
- 21st session prunes the oldest `copilot-session-*` memory

#### Install/Uninstall Lifecycle

- Extension writes `~/.copilot/hooks/pali.json` (idempotent, `PALI_HOOKS_DIR` override, warning on write failure)
- Uninstall deletes hooks file only when wholly pali-owned (all entries reference `copilot-hooks.mjs`)
- Missing file is NOT an error
- Shared hooks file with other tools is left untouched

### CLI Integration

- No new CLI commands — capability is VS Code hook-based
- Hook test suite under `hooks/test/`: digest, stop hook, backfill, stubbed pali

### Design Rationale

- Best-effort approach: hook failures never block the coding host
- Single dispatcher reduces surface area and complexity
- Deterministic digests ensure replay consistency
- Per-project bounds prevent memory store growth unboundedness
