# Proposal: Copilot session capture hooks

## Why

pali's value compounds when Copilot conversations feed it: relevant
memories should flow into a session at start and prompt time, and finished
sessions should come back as durable memories. Commit `70577cd` shipped the
whole client-side suite — the hook dispatcher, session digest, backfill
script, extension-side hook registration, and uninstall cleanup — with no
OpenSpec change. The existing `hooks-copilot-hooks-infrastructure` change
only specifies git pre-commit hooks, and its own proposal admitted a
`copilot-hook-config` capability it never described. This change records the
delivered Copilot-hooks capability and closes that gap.

## What Changes

- Hook dispatcher `hooks/copilot-hooks.mjs`: one entry point for
  `sessionStart`, `userPromptTransformed`, and `agentStop`.
- Session digest (`pali-session-digest.mjs`) + capture
  (`pali-session-capture.mjs`): deterministic, transcript-derived session
  memories stored through pali, with per-project retention.
- `hooks/backfill-sessions.mjs`: import existing transcript files as
  digests.
- Extension installs a user-level hooks file and `src/uninstall.ts` removes
  it on uninstall, scoped to pali-owned content.
- `hooks/pali-client.mjs` transport pattern: short-lived `pali serve`
  over stdio, exactly one `tools/call` per hook invocation, best-effort.

## Capabilities

### New Capabilities

- `copilot-session-capture`: Copilot hook integration that recalls memories
  into sessions and captures finished sessions as digest memories, with
  owned-config install/uninstall lifecycle.

### Modified Capabilities

- (none — this supersedes the undescribed `copilot-hook-config` promise in
  `hooks-copilot-hooks-infrastructure`'s proposal)

## Impact

- `hooks/` suite: `copilot-hooks.mjs`, `copilot-session-capture.mjs`,
  `pali-session-digest.mjs`, `backfill-sessions.mjs`, `pali-client.mjs`,
  tests under `hooks/test/`.
- `src/extension.ts` (hooks install at activation), `src/utils/lib.ts`
  (`buildHookConfig`), `src/uninstall.ts` (cleanup).
- Writes `~/.copilot/hooks/pali.json` (overridable via `PALI_HOOKS_DIR`).
- Stdio only: hooks spawn `pali serve` with no transport flag (stdio is the
  sole transport since pali 1.0.1).
