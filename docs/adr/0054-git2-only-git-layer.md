# ADR-0054: git2 (libgit2) is the only git layer

## Status

Accepted. Supersedes [ADR-0053](0053-gix-read-paths.md).
[ADR-0002](0002-git2-over-shell.md) is unchanged: no shelling out to the `git`
CLI; `git2` (libgit2) is the git layer for both reads and writes.

## Context

ADR-0053 split git access by operation class: `gix` (gitoxide) for the three
read-only operations — resolving `HEAD`, comparing two commits' trees, and
reading blobs — and libgit2 for everything that mutates a repository. The
split was motivated by portability and feature-pinning: gix is pure Rust and
adds no C surface, and its read-only feature set was small enough to pin.

A year on, the split's costs outweighed its benefits:

- Two git implementations are linked into every binary and compiled for every
  build, and the `gix` dependency is one of the largest in the tree.
- The split added a seam module (`git_read.rs`) whose only job is to translate
  between the two libraries' object models — pure cost, since neither side
  could see the other's invariants.
- `gix::Error` is a boxed trait object, which forced a lossy
  `MemoryError::Gix(String)` variant (no structured error, no `#[from]`) and
  a hand-rolled hex bridge for 20-byte object ids.
- The read paths themselves are small: a `HEAD` peel, a recursive two-tree
  walk, and a blob read. All three are one or two lines in git2.

The original motivation — avoiding a second network stack or C dependency — no
longer applies: gix was pinned to `revision` + `sha1` + `status` precisely
because it added no transport, so removing it removes no network code.

## Decision

Delete `gix` and re-implement the three read operations on `git2`:

- `head_sha`: `Repository::head().peel_to_commit()` — the same call the
  write path already uses in `capture_head_oid`. An unborn branch or missing
  HEAD reports `None`, matching the previous gix behaviour.
- `untracked_files`: `git2::StatusOptions` with `include_untracked`,
  `recurse_untracked_dirs`, and `include_ignored(false)`; the `WT_NEW` set is
  the same enumeration `gix::status::UntrackedFiles::Files` produced. The
  scanner keeps its existing status call and gains a direct call here.
- `changed_files` / tree diff: a recursive walk of `git2::Tree` between two
  commit trees, keeping the existing `ChangeKind` classification (added,
  removed, modified, type-changed; `100644`/`100755` are both regular
  files). Blob content is read eagerly for the returned memory paths, as
  before.

`MemoryError::Gix` is removed; read failures surface as `MemoryError::Git`
(the existing `#[from] git2::Error` variant). The `gix_untracked_enumeration_matches_libgit2`
parity test is deleted — with one library there is nothing to compare
against — and its assertions are kept as a standalone regression test on the
git2 implementation alone (untracked directories expand to their files;
ignored files stay out).

The public change-set contract is unchanged: `diff_changed_memories` and
`diff_changed_refs` still report `.md` paths under `global/` and `projects/`
with the same added/removed/type-changed semantics.

## Consequences

- One git implementation in the tree; the `gix` dependency and the
  `MemoryError::Gix` variant are gone. Neither is a semver break against
  v1.0.1: the dependency and variant existed only in unreleased commits
  after v1.0.1, and `MemoryError` is `#[non_exhaustive]`, so no downstream
  code can match the removed variant. Verified with
  `cargo semver-checks check-release --baseline-rev v1.0.1` (202 pass,
  58 skip, no semver update required).
- `git_read.rs` disappears; the three helpers live where their consumers are
  (repository diff for the tree walk and blob reads, repository HEAD for
  `head_sha`, scanner status for untracked files).
- Reads take no additional lock: the read helpers open the repository
  read-only on the calling thread, as they did under gix.
- ADR-0053 is superseded in full; ADR-0002 governs the whole git layer again.
