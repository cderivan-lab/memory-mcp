# Proposal: Unify the `pali` git layer on git2

## Why

The `pali` crate currently runs its git read paths on `gix` (introduced in
1.1.0 behind the `git_read` seam, ADR-0053) while every write path stays on
`git2`. Maintaining two git libraries means two dependency trees, two sets of
behavioral quirks (status iteration, submodule handling, object lifetimes), and
a read/write split that is only visible if you read the ADRs. The motivation
recorded in ADR-0053 — dropping vendored OpenSSL by replacing git2 — is no
longer decisive: `gix` itself pulls in a much larger transitive tree, and the
crate's actual dependency surface shrank when the read seam was written. One
native library for all git work is the simpler, lower-surface choice.

## What Changes

- Remove the `gix` dependency and `pali/src/git_read.rs` entirely.
- Re-implement the three gix-backed reads on `git2` in `repo.rs`:
  - `head_sha`: HEAD → commit oid (`Repository::open` + `head` + `peel_to_commit`).
  - `changed_files` / tree diff: `git2::Tree` recursion between two oids,
    producing the same `(path, ChangeKind, old_content, new_content)` results
    callers already decomposed.
  - untracked-file enumeration for the scanner: `git2::StatusOptions` with
    `include_untracked(true)`, `recurse_untracked_dirs(true)`,
    `include_ignored(false)`, filtered to `WT_NEW` — byte-identical semantics
    to the previous gix `untracked_files` output.
- Remove `MemoryError::Gix` (a `#[non_exhaustive]` enum variant that existed
  only between the v1.0.1 release and this change) — not a semver break:
  the variant was never published, and `#[non_exhaustive]` forbids
  downstream code from matching it exhaustively. Recorded in
  `pali/CHANGELOG.md` under `Unreleased`.
- Reads still do not take the writer's mutex; the `unsafe impl Send/Sync`
  on `MemoryRepo` and all write-path behavior are unchanged.
- ADR-0053 is superseded in full by `docs/adr/0054-git2-only-git-layer.md`.

## Impact

- Affected specs: `repository-scanner` (untracked-file enumeration backend).
- Affected code: `pali/src/repo.rs`, `pali/src/scanner.rs`,
  `pali/src/error.rs`, `pali/src/lib.rs`, `pali/Cargo.toml`,
  `pali/CHANGELOG.md`; deleted `pali/src/git_read.rs`.
- Affected change: `migrate-git2-to-gix` is being **withdrawn** (0/66 tasks
  done) — this change supersedes its read-path scope; its `git-backend-gix`
  delta spec is deleted with the change.

## Tasks

- [x] 1.1 Write ADR-0054 (Accepted, supersedes ADR-0053 in full)
- [x] 1.2 Re-implement `head_sha`, tree diff, and blob reads on git2 in `repo.rs`
- [x] 1.3 Re-implement scanner untracked enumeration on `git2` status options
- [x] 1.4 Delete `git_read.rs`, the `gix` dependency, and `MemoryError::Gix`
- [x] 1.5 Add `pali/CHANGELOG.md` entry under `Unreleased`
- [x] 1.6 Full suite green: `cargo nextest run --workspace --no-fail-fast`
      (582 passed, 1 skipped, 0 failed)
- [x] 1.7 Run `cargo semver-checks check-release --baseline-rev v1.0.1
      -p pali` (default features; there is no feature-gated build left after
      the otlp removal) and record the result: 202 pass, 58 skip,
      "no semver update required". Expected: the gix dependency and the
      `MemoryError::Gix` variant existed only in unreleased commits after
      v1.0.1, so the check sees no public-API change against the baseline.
- [x] 1.8 Supersede the `migrate-git2-to-gix` change and delete its
      `git-backend-gix` delta spec
