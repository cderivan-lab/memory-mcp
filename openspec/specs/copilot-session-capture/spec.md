# copilot-session-capture Specification

## Purpose

Close the loop between Copilot sessions and the memory store: recall project
memories into fresh sessions and relevant memories into prompts, and capture
finished sessions as deterministic digest memories — all best-effort so the
coding host never blocks or fails because pali is unhealthy.

## Requirements

### Requirement: One dispatcher serves all three hook events

The hooks SHALL install a single entry point (`hooks/copilot-hooks.mjs`) for
`sessionStart`, `userPromptTransformed`, and `agentStop`, inferring the event
from the stdin payload or an explicit first argument, and a hook failure
SHALL never propagate to the host: on any internal error the hook returns
the host's expected shape (or nothing) and exits successfully.

#### Scenario: pali binary missing

- **WHEN** `agentStop` fires while no pali binary is resolvable
- **THEN** the hook exits without an error status and the agent session
  closes normally

### Requirement: sessionStart recalls project memories once

On `sessionStart` the hook SHALL recall memories for the project scope and
inject them into `additionalContext`, tracking what was injected for the
session so a repeated start does not duplicate the same memory block.

#### Scenario: Fresh session sees project memories

- **WHEN** `sessionStart` runs in a project whose scope holds memories
- **THEN** `additionalContext` contains a formatted memory block for those
  memories

### Requirement: prompt transform recalls prompt-relevant memories

On `userPromptTransformed` the hook SHALL recall memories relevant to the
prompt text and return them in `modifiedTransformedPrompt`, leaving the
prompt unchanged when recall yields nothing or fails.

#### Scenario: Recall failure degrades to the original prompt

- **WHEN** the memory call times out during prompt transform
- **THEN** `modifiedTransformedPrompt` is the unmodified prompt

### Requirement: agentStop captures a deterministic digest

On `agentStop` the hook SHALL build a digest from the transcript alone —
requests, modified files, executed commands, failures, and how the session
ended, trimmed to keep the session's final state — with no model call, and
store it as one memory named `copilot-session-<day>-<session-id>` tagged
`session`, `auto-capture`, and `harness:copilot-cli`. A digest byte-identical
to the stored memory SHALL NOT be rewritten.

#### Scenario: Repeat stop on an unchanged session writes nothing

- **WHEN** `agentStop` fires twice for a session whose transcript has not
  changed
- **THEN** the second run issues no memory write

#### Scenario: Sessions without content are skipped

- **WHEN** the transcript has no requests and no tool activity
- **THEN** no memory is created

### Requirement: Captured sessions are retained per project with bounds

Capture SHALL retain the newest `PALI_HOOK_KEEP_SESSIONS` session memories
per project scope (default 20), pruning older `copilot-session-*` memories,
and `PALI_HOOK_KEEP_SESSIONS=0` SHALL disable pruning.

#### Scenario: The 21st session prunes the oldest

- **WHEN** a project already holds 20 session memories and a new capture
  lands with default settings
- **THEN** the oldest `copilot-session-*` memory is removed and 20 remain

### Requirement: Hook transport is a short-lived stdio server per call

Each hook invocation SHALL spawn a short-lived `pali serve` (no transport
flag; stdio is the only transport), perform the MCP handshake, issue exactly
one `tools/call`, and exit; hook log files SHALL be created with mode 0600.

#### Scenario: Recall and capture use one call each

- **WHEN** a `sessionStart` and an `agentStop` hook complete
- **THEN** each spawned its own `pali serve` process and issued exactly one
  tool call before exit

### Requirement: The extension installs a user-level hooks config

The extension SHALL write `~/.copilot/hooks/pali.json` (directory overridable
with `PALI_HOOKS_DIR`) registering the dispatcher for the three events with
per-event timeouts, SHALL leave the file untouched when its content is
already current, and SHALL surface write failures as a warning without
blocking activation.

#### Scenario: Idempotent activation

- **WHEN** the extension activates twice with unchanged settings
- **THEN** the hooks file is written once and its mtime does not change on
  the second activation

### Requirement: Uninstall removes only pali-owned hook config

The extension's uninstall script SHALL delete the hooks file only when every
entry in it references pali's `copilot-hooks.mjs`; a file with foreign or
mixed entries SHALL be left untouched, and a missing file SHALL NOT be an
error.

#### Scenario: Stale config would break every hook event

- **WHEN** pali is uninstalled while `~/.copilot/hooks/pali.json` still
  points at the removed extension directory
- **THEN** uninstall deletes that file so later hook events do not fail with
  `MODULE_NOT_FOUND`

#### Scenario: A shared hooks file survives

- **WHEN** `~/.copilot/hooks/pali.json` contains an entry from another tool
- **THEN** uninstall leaves the file in place