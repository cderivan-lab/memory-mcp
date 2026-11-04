# Proposal: Migrate the `pali` git2 dependency to gix

## Why

`pali` (the Rust crate behind the VS Code extension) currently depends on
`git2 0.21.0` for every git operation — init, index staging, commit,
checkout, fetch, merge, push, and credential callbacks — and that single
dependency is the only reason the crate vendors OpenSSL (ADR-0023). The
read-only half of the work is already done: `pali/src/git_read.rs` is fully
gix and `docs/adr/0053-gix-read-paths.md` records that reads no longer contend
with the writer's mutex. A wholesale swap is blocked today by `push` (gix 0.90
has no send-pack/receive-pack client plumbing, no report-status, and no atomic
push) and by pure-Rust SSH (`gix-ssh` is entirely unchecked). The prize is
deleting vendored OpenSSL, not API elegance. This change executes the migration
in the order that removes the most structural code first: scanner →
init/staging/commit/checkout → network → push, keeping git2 only as a push
fallback behind `git push --porcelain --atomic`.

## What Changes

- **Replace git2 with gix on read paths** in `pali/src/scanner.rs`
  (`Repository::open`, `head_commit`, `commit_messages`, `list_paths`,
  `blame_lines`), extending the existing `git_read.rs` seam.
- **Rebuild commits as pure-tree writes** so the index disappears: read the
  HEAD tree, overlay one path, write blob + tree + commit, CAS the ref, and
  regenerate `.git/index` from the tree just written. This deletes
  `index_from_head`, `stage_add`, `stage_remove`, and `commit_index`.
- **Rebuild merge as a three-way tree selection** (`ours==theirs→keep;
  ours==base→theirs; theirs==base→ours; else newer `updated_at` wins, ties→ours`),
  deleting `MERGE_HEAD`/`conflict_remove`/`cleanup_state` and every call into
  `gix-merge`.
- **Materialize the worktree through pali's own `write_memory_file`** instead
  of `checkout_head(force)`, which currently bypasses `assert_within_root`,
  the symlink walk, the `O_NOFOLLOW` probe, and `atomic_write`.
- **Move network last**: fetch/merge/pull over gix, with push kept as a
  subprocess (`git push --porcelain --atomic`) and git2 retained only as the
  fallback when the subprocess is unavailable.
- **Introduce a `local_only` branch**: when the repository has no configured
  remote, the whole mutation path runs without any network client, and the
  push fallback is skipped entirely.
- **Delete `unsafe impl Send` / `unsafe impl Sync`** on `MemoryRepo` once
  `gix::Remote<'_>` (which is `!Send`) is no longer held across threads.
- **Change the error model**: `MemoryError::Git(#[from] git2::Error)` becomes
  `MemoryError::Gix(String)` (gix's error is a boxed trait object and cannot
  carry `#[from]`); `ErrorCode::NotFound`/`NonFastforward` classification is
  lost at the API boundary and must be re-derived from gix's error kind.
- **Add a differential parity harness** extending
  `gix_untracked_enumeration_matches_libgit2` to cover commits, merges, and
  checkouts against a libgit2 reference.

**BREAKING**: the public `MemoryError` enum shape changes; `push` is no longer
a first-class gix capability and is gated behind the subprocess fallback.

## Capabilities

### New Capabilities

- `git-backend-gix`: read-only git operations (open, init, HEAD, blame, status,
  untracked enumeration, tree/blob diffing, merge-base) through gix, with the
  gix type surface confined to `git_read.rs` and the new `git_write.rs` seam.
- `local-only-repo`: mutation path that runs with no network client when the
  repository has no configured remote; push is skipped, not attempted.
- `push-via-subprocess`: push performed through `git push --porcelain --atomic`,
  with git2 retained only as a fallback when the git binary is unavailable.

### Modified Capabilities

- `repository-scanner`: `scanner.rs` opens and inspects repositories through
  gix instead of git2; the scanner's observable output (file list, blame,
  commit subjects) is unchanged, so the requirement text is unchanged but the
  implementation contract moves to the gix seam.

## Impact

- `pali/Cargo.toml`: add `gix` (features `revision`, `sha1`, `status`,
  `extras` default) and keep `git2` only behind a `push-fallback` feature;
  remove `vendored-openssl` once push no longer needs it.
- `pali/src/scanner.rs`, `pali/src/git_read.rs`, `pali/src/repo.rs`,
  `pali/src/error.rs`: the four modules that currently name `git2::`.
- `pali/src/git_write.rs` (new): the pure-tree commit, three-way merge, and
  worktree-materialization seam.
- `pali/tests/`: parity harness against a libgit2 reference.
- `docs/adr/0053-gix-read-paths.md`: superseded in part by the new ADR covering
  the write path.
- Security: the migration widens the credential-helper boundary (gix invokes
  the system helper where git2 used a custom callback), re-exposes
  `ProxyCommand` code-execution risk, and requires token-in-URL sanitisation
  on the new transport path; SSH posture is deferred to the operator
  (k8s image per ADR-0014, bare Windows).