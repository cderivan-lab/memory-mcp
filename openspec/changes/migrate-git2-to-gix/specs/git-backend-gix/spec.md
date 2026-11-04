# Spec Delta

## Purpose

All git access in `pali` is funneled through two seams — `git_read.rs` (already
gix) and the new `git_write.rs` — so that no module outside those two names a
`git2::` or `gix::` type directly. The gix surface is confined, the read and
write paths never contend on the same mutex, and every observable git
behaviour has a parity test against a libgit2 reference.

## ADDED Requirements

### Requirement: Gix types live in exactly two modules

The crate SHALL expose `gix::` types only from `pali::git_read` and
`pali::git_write`. Every other module SHALL receive plain paths, byte
buffers, object identifiers, and domain enums.

#### Scenario: No gix or git2 name outside the seams

- **WHEN** the crate is compiled with `#![warn(missing_docs)]`
- **THEN** no source file outside `git_read.rs` and `git_write.rs` contains a
  `gix::` or `git2::` path

### Requirement: Read paths no longer hold the writer mutex

Reading a repository (HEAD, status, untracked files, blame, diff) SHALL not
take `MemoryRepo.inner`, and a concurrent write SHALL not block reads or be
blocked by them.

#### Scenario: Reads proceed while a write is in flight

- **WHEN** one task holds `MemoryRepo.inner` writing a commit
- **THEN** a second task can read the HEAD sha and the worktree status
  without waiting on the mutex

### Requirement: Commits are pure-tree writes with no index

Saving a memory SHALL read the HEAD tree, overlay the single memory path,
write the blob and the new tree, write the commit, and CAS the ref forward —
and SHALL regenerate `.git/index` from the tree just written. The crate SHALL
not call `git2::Index::add`, `Index::remove`, or any staging primitive.

#### Scenario: A saved memory is visible to a fresh reader

- **WHEN** `save_memory` completes for path `memories/foo.md`
- **THEN** a subsequent `read_memory("foo.md")` returns the new content
- **AND** `git_read::head_sha` reflects the new commit

#### Scenario: Unborn branch commits without a parent

- **WHEN** `save_memory` runs on a repository whose HEAD is an unborn branch
- **THEN** the written commit has no parent and the ref points at it

### Requirement: Merge is a three-way tree selection

`merge_with_remote` SHALL resolve each path by comparing the local, remote,
and base versions (`ours==theirs` → keep; `ours==base` → theirs;
`theirs==base` → ours; else the newer `updated_at` wins, ties → ours) and
SHALL not write `MERGE_HEAD`, `MERGE_MSG`, or `MERGE_MODE`, and SHALL not
call any `gix-merge` entry point.

#### Scenario: A fast-forward-shaped merge needs no merge commit

- **WHEN** the remote is a direct descendant of local
- **THEN** the ref moves to the remote commit and no merge state is left on
  disk

#### Scenario: A genuine three-way merge picks the newer side

- **WHEN** local and remote both modify `m.md` from base, local with the newer
  timestamp
- **THEN** the worktree holds local's content and no conflict marker is
  written

### Requirement: Worktree materialization uses pali's own writer

Restoring a memory to the worktree SHALL go through `write_memory_file`, which
applies `assert_within_root`, the symlink walk, the `O_NOFOLLOW` probe, and
`atomic_write`. The crate SHALL not call `git2::Repository::checkout_head` or
any `CheckoutBuilder`.

#### Scenario: A checkout cannot escape the repository root

- **WHEN** a memory path resolves to a symlink that points outside the root
- **THEN** the write is refused and `write_memory_file` returns an error
  rather than following the symlink

### Requirement: The error model carries gix, not git2

`MemoryError` SHALL have a `Gix(String)` variant and no longer a
`Git(#[from] git2::Error)` variant. `ErrorCode::NotFound` and
`NonFastforward` SHALL be re-derived from gix's error kind at the seam.

#### Scenario: A missing object is a gix error

- **WHEN** `read_memory` looks up a blob that does not exist
- **THEN** the returned error is `MemoryError::Gix` and its message names the
  missing object, not a libgit2 status code
