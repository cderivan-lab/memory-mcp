# Spec Delta

## Purpose

When a repository has no configured remote, pali runs its entire mutation
path with no network client at all and skips push rather than attempting it.
This keeps the `local_only` branch free of the gix network feature flags that
are otherwise opt-in, and makes the absence of a remote a first-class,
tested state instead of a silent fallback.

## ADDED Requirements

### Requirement: A repository with no remote runs without a network client

`MemoryRepo` SHALL detect the absence of a configured remote at open time and
SHALL not construct a gix network client, enable any network feature flag, or
attempt any fetch, push, or pull operation for that repository.

#### Scenario: No remote means no network feature is compiled in

- **WHEN** `pali` is built for a repository whose `git config` has no
  `remote.*.url`
- **THEN** the binary does not pull in `blocking-network-client` or
  `blocking-http-transport-reqwest-rust-tls`

#### Scenario: A push to a local-only repository is skipped, not failed

- **WHEN** `push` is called on a repository with no configured remote
- **THEN** the call returns immediately with no network activity and no error

### Requirement: Local-only state is observable and stable

The repository SHALL expose a `local_only` flag that is `true` exactly when no
remote is configured, and that flag SHALL not change across a save, a merge,
or a checkout performed through pali.

#### Scenario: Saving a memory does not change local-only status

- **WHEN** `save_memory` runs on a local-only repository
- **THEN** the `local_only` flag remains `true` afterwards

### Requirement: Local-only repositories still commit and restore

A local-only repository SHALL save, read, list, move, and delete memories and
SHALL regenerate the worktree through `write_memory_file` exactly as a
remote-backed repository does.

#### Scenario: A local-only save is readable

- **WHEN** `save_memory("a.md", "x")` runs on a local-only repository
- **THEN** `read_memory("a.md")` returns `"x"` and `head_sha` advances

#### Scenario: A local-only move rolls back on failure

- **WHEN** `move_memory` on a local-only repository fails after staging the
  removal
- **THEN** the worktree is restored through `write_memory_file` and the
  original content is still readable
