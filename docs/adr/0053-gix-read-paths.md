# ADR-0053: gix for read paths, libgit2 for merge and push

## Status
Accepted. Supersedes [ADR-0002](0002-git2-over-shell.md) for read-only
access only; ADR-0002 still governs the write path and the rejection of
shelling out to the `git` CLI.

## Context

ADR-0002 chose `git2` (libgit2) over shelling out, for build-time coupling and
no runtime `git` dependency. That decision still holds for anything that
mutates a repository.

`gitoxide` (`gix`) offers a pure-Rust implementation with a considerably
smaller C surface, but its own crate-status table lists the write operations
this crate needs under "common workflows that still need plumbing":

- merge, cherry-pick and revert — mainly `gix`, `gix-merge`
- push, and self-contained clone/fetch over `file://` and `ssh://` — mainly
  `gix`, `gix-protocol`, `gix-transport`, `gix-ssh`

`pali/src/repo.rs` depends on both: `merge_analysis`/`merge` for a
non-fast-forward pull, and `Remote::push` (including the
`push_update_reference` callback that surfaces server-side branch-protection
rejections as `MemoryError::PushRejected`). Neither has a shippable gix
equivalent in 0.90.

A wholesale rename of `git2::` to `gix::` does not work: the two crates model
different things (`gix::MergeOptions`, `gix::build::CheckoutBuilder` and
`gix::Cred::ssh_key` are libgit2 shapes with no gix counterpart). Attempting it
produces a crate that does not compile.

## Decision

Split by operation class.

**gix owns read-only access**, behind `pali/src/git_read.rs`, which is the only
module that names gix types:

- resolving `HEAD` to a commit id (`head_sha`)
- comparing two commits' trees and reporting changed memory files
- reading blobs out of those trees

`diff_changed_memories` and `diff_changed_refs` are built on a recursive tree
walk over gix objects rather than a rename-detecting diff. That is a
deliberate simplification: the previous libgit2 call reported a rename as one
delta, which the callers immediately decomposed into "remove the old path,
upsert the new one" — exactly what a delete plus an add produces. The change
set is identical, and the walk needs no `blob-diff` feature.

**libgit2 keeps every mutation**: repository init, index staging, commit,
checkout/reset, fetch, merge, push, and the credential callbacks. The pull path
stays entirely on libgit2, including `capture_head_oid`, because it is part of
a write transaction.

Features are pinned to `default-features = false, features = ["revision", "sha1"]`.
`sha1` is required: without a hash kind, `gix-hash`'s `Kind` enum has no
variants and its `match` fails to compile. No transport, TLS, or credential
features are enabled, so the TLS consolidation in
[ADR-0023](0023-supply-chain-tls-and-vendoring.md) is untouched — gix adds no
second network stack.

`MemoryError` gains a `Gix(String)` variant. `gix::Error` is a boxed trait
object, so it cannot carry `thiserror`'s `#[from]`; the message is what every
caller surfaces, and the variant is `#[non_exhaustive]` like the rest of the
enum.

## Consequences

- Reads no longer need the writer's `Mutex<git2::Repository>`, so `head_sha`
  cannot block behind an in-flight commit and does not contend with it.
- Two git implementations are linked. That was already true in spirit
  (libgit2, plus its bundled libssh2/OpenSSL); gix adds pure-Rust parsing, not
  another C dependency.
- The public change-set contract is unchanged: paths, `.md` filtering, the
  `unqualified name` form, and the `unresolved` counter all behave as before.
  Type changes still produce an old-side removal plus a new-side upsert.
- Out-of-tree object ids that are not valid hex become `Internal` rather than
  a git error, because the 20-byte representation is a crate contract that
  gix cannot validate directly.
- The scanner's untracked-file enumeration still uses libgit2's status API. It
  asks for the exact `WT_NEW` set with libgit2's ignore semantics, and the
  read path there is not on a hot loop. Moving it is a separate change with
  its own behaviour comparison.
- Revisit this split when `gix-merge` and push are shippable: at that point
  ADR-0002 can be superseded outright and libgit2 dropped.
