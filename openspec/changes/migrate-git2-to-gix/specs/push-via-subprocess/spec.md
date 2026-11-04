# Spec Delta

## Purpose

Push is the one git operation gix 0.90 cannot express (no send-pack/receive-pack
client plumbing, no report-status, no sideband, no delete-refs, no push-options,
no atomic push). Rather than block the whole migration, push is performed
through `git push --porcelain --atomic`, with git2 retained only as a fallback
when the git binary is unavailable. The subprocess path is parseable,
deterministic, and never leaks tokens through command arguments.

## ADDED Requirements

### Requirement: Push runs through `git push --porcelain --atomic`

`push` SHALL invoke the git binary with `push --porcelain --atomic` against
the remote's URL and SHALL parse the porcelain output for the per-ref
status. The crate SHALL not construct a send-pack request through gix.

#### Scenario: A successful push reports each ref

- **WHEN** `push` runs against a remote that accepts the update
- **THEN** the returned status names every ref pushed and marks each as
  `ok`, with no `rejected` entries

#### Scenario: A non-fast-forward push is reported, not retried

- **WHEN** `push` runs against a remote whose ref has moved since fetch
- **THEN** the returned status marks the ref `rejected` with the remote and
  local sha, and the local ref is left unchanged

### Requirement: The subprocess never receives a token in its arguments

The remote URL passed to `git push` SHALL carry credentials only through the
configured credential helper or an environment variable that is scoped to the
subprocess and unset immediately after; the token SHALL never appear in the
URL string, in `argv`, or in the process's public environment.

#### Scenario: A token-bearing URL is rewritten before the subprocess starts

- **WHEN** the configured remote URL is `https://x-access-token:glpat-SECRET@host/r`
- **THEN** the `git push` command is launched with a URL in which the secret
  is removed and the token is supplied only through the credential helper

### Requirement: Git2 is the fallback when the git binary is missing

When the git binary cannot be resolved on `PATH`, `push` SHALL fall back to
the git2 send-pack path and SHALL log that the fallback is in use. The
fallback exists only to keep older deployments working; it is not a permanent
capability.

#### Scenario: No git binary on PATH uses the git2 fallback

- **WHEN** `which git` returns nothing on the host `PATH`
- **THEN** `push` succeeds through git2 and the span records
  `push.fallback=git2`

#### Scenario: The git2 fallback is removed when the binary is present

- **WHEN** the host has a usable `git` binary
- **THEN** the git2 send-pack path is never taken for push
- **AND** the build does not require the `push-fallback` feature to be enabled

### Requirement: Atomic push prevents partial ref updates

`push` SHALL pass `--atomic` so that either every ref updates or none does.

#### Scenario: A mid-push failure rolls back all refs

- **WHEN** `push` of two refs fails on the second ref
- **THEN** the first ref is not updated on the remote either, and the local
  status reports every ref as `rejected`
