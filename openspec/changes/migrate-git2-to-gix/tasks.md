# Tasks

## 0. Pre-flight gate

- [ ] 0.1 Read [pali/Cargo.toml](../../../../pali/Cargo.toml); capture a
  `cargo tree -e features -i pali` baseline before any edit so the OpenSSL
  deletion has a measurable before/after.
- [ ] 0.2 Verify gix 0.90's MSRV against
  `rust-version = "1.99"` in [pali/Cargo.toml](../../../../pali/Cargo.toml);
  file a blocker if gix's MSRV exceeds 1.99.
- [ ] 0.3 Read the consumers of `conflicts_resolved` in
  [pali/src/server.rs](../../../../pali/src/server.rs) and any sibling
  router module, record every call site that depends on "conflict" being a
  user-intervention state, and decide whether the no-marker three-way rule
  (D-2) preserves or breaks each one.
- [ ] 0.4 Read [docs/adr/0053-gix-read-paths.md](../../../../docs/adr/0053-gix-read-paths.md),
  [docs/adr/0002-git2-over-shell.md](../../../../docs/adr/0002-git2-over-shell.md),
  and [docs/adr/0021-scope-affinity-defaults.md](../../../../docs/adr/0021-scope-affinity-defaults.md);
  confirm "no shelling out to git" is still the live posture. If a new
  subprocess push (D-5) is genuinely required by the push blocker, add a new
  ADR (not modify the existing) that supersedes 0002 only for the push path,
  using the next available number.
- [ ] 0.5 Confirm an ADR covering the new Accepted decisions D-1, D-2, D-3
  is written (and Accepted) before step 2 lands in code.
- [ ] 0.6 Land the new ADR covering D-1, D-2, D-3 as Accepted in
  `docs/adr/` before any step 1+ code change.

## 1. Scanner

- [ ] 1.1 Replace `Repository::open` with a `git_read::open_repo` helper in
  [pali/src/scanner.rs](../../../../pali/src/scanner.rs); the helper hands
  back the same struct used by [pali/src/git_read.rs](../../../../pali/src/git_read.rs).
- [ ] 1.2 Replace `Repository::head_commit` with `head_sha` plus
  `git_read::commit_subject`; keep the existing commit-subject truncation.
- [ ] 1.3 Reimplement `commit_messages` over
  [pali/src/git_read.rs](../../../../pali/src/git_read.rs) commit walking,
  with the same ordering and the same 5-entry bound used in the manifest.
- [ ] 1.4 Reimplement `list_paths` (tracked + untracked, honoring
  `.gitignore`, never following nested repos) over
  [pali/src/git_read.rs](../../../../pali/src/git_read.rs), mirroring the
  existing `gix_untracked_enumeration_matches_libgit2` invariant
  end-to-end.
- [ ] 1.5 Reimplement `blame_lines` over
  `gix::annotate::blame` in [pali/src/git_read.rs](../../../../pali/src/git_read.rs);
  emit commit IDs and line numbers only, never author names, emails, or
  content.
- [ ] 1.6 Extend the differential parity harness for `list_paths`,
  `commit_messages`, and `blame_lines` against a libgit2 reference (mirror
  `gix_untracked_enumeration_matches_libgit2`).
- [ ] 1.7 Run `cargo nextest run --workspace --no-fail-fast`; run default
  and `--all-features` per `AGENTS.md`.
- [ ] 1.8 Re-run `cargo tree -e features -i pali`: confirm vendored OpenSSL
  is still present (git2 is still in the tree), so a regression of step 0.1
  is detected.

## 2. Pure-tree commit

- [ ] 2.1 Add `pali/src/git_write.rs` with a `write_memory_tree(head, path,
  content) -> new_tree` function that reads the HEAD tree (empty tree for an
  unborn HEAD), applies the one-path overlay, prunes empty parents, and
  writes the resulting tree.
- [ ] 2.2 Add `commit_at(head_commit, tree, message, signature) -> new_commit`
  and `compare_and_swap_ref(head_ref, expected, new)` to
  [pali/src/git_write.rs](../../../../pali/src/git_write.rs).
- [ ] 2.3 Add a `regenerate_index(tree)` helper that writes a libgit2-and-git
  CLI compatible `.git/index` from the tree just committed. This is for
  developer convenience; nothing in the crate reads it back.
- [ ] 2.4 Rewrite `save_memory` in
  [pali/src/repo.rs](../../../../pali/src/repo.rs) to use D-1: read HEAD →
  `write_memory_tree` → `commit_at` → CAS.
- [ ] 2.5 Rewrite `delete_memory` and `move_memory` to use D-1 with the
  remove/modify path of the same overlay.
- [ ] 2.6 Delete `index_from_head`, `stage_add`, `stage_remove`, and
  `commit_index` from
  [pali/src/repo.rs](../../../../pali/src/repo.rs).
- [ ] 2.7 Delete the `git2::Index`/`Oid` types from
  [pali/src/repo.rs](../../../../pali/src/repo.rs) and the `use git2::...`
  statement. If `repo.rs` still uses any other git2 type (Signature,
  CheckoutBuilder, MergeOptions, Repository, ErrorCode), keep that single
  use statement narrow.
- [ ] 2.8 Move the rollback path used by `move_memory` (currently
  `CheckoutBuilder::default().force()` + `checkout_head`) to a
  `restore_paths_from_head(path_set)` helper in
  [pali/src/git_write.rs](../../../../pali/src/git_write.rs) that uses D-3.
- [ ] 2.9 Add parity tests asserting every git2 save, delete, and move
  produces the same tree, ref, and worktree bytes as the gix version.
- [ ] 2.10 Run nextest; record a regression name for every new test
  (per `AGENTS.md`, non-vacuous tests).

## 3. Worktree materialization

- [ ] 3.1 Add `git_write::materialize_from_tree(tree, path_filter)` that
  walks the new tree, reads each blob, and writes the file through the
  existing `write_memory_file` in
  [pali/src/repo.rs](../../../../pali/src/repo.rs). Refuse any path where
  `write_memory_file`'s `assert_within_root`, symlink walk, `O_NOFOLLOW`
  probe, or `atomic_write` rejects the write; never bypass those checks.
- [ ] 3.2 Replace `checkout_head(force)` with `materialize_from_tree`
  in the rollback path at `repo.rs:1470` and anywhere else
  `CheckoutBuilder::default().force()` appears in
  [pali/src/repo.rs](../../../../pali/src/repo.rs).
- [ ] 3.3 Add tests for materialization with: an unborn HEAD; a deleted
  memory; a path with no existing file; a path whose existing file is a
  symlink pointing outside the root (expect rejection).
- [ ] 3.4 Run nextest; re-run any security-shaped test in
  [pali/tests/](../../../../pali/tests) related to path escapes.

## 4. Three-way merge

- [ ] 4.1 Add `git_write::merge_trees(ours, theirs, base, by_updated_at)`
  to [pali/src/git_write.rs](../../../../pali/src/git_write.rs) using the D-2
  rule.
- [ ] 4.2 Rewrite `merge_with_remote` at `repo.rs:769` to: fetch → compute
  base = merge-base → `merge_trees` → write a single commit (or fast-forward
  if `ours` is an ancestor of `theirs`).
- [ ] 4.3 Delete `resolve_conflicts_by_recency` at `repo.rs:1075`, plus the
  `conflict_remove` and `cleanup_state` paths in
  [pali/src/repo.rs](../../../../pali/src/repo.rs), and the `gix::merge` /
  `gix-merge` feature flag in [pali/Cargo.toml](../../../../pali/Cargo.toml).
- [ ] 4.4 Add `pull` as `fetch → merge_trees → materialize`; keep
  `MemoryError::PushRejected` for genuine divergence the rule cannot resolve.
- [ ] 4.5 Add a parity test for: fast-forward-only merge; a genuine
  three-way on `m.md`; a delete-vs-modify; and the no-conflict-marker
  guarantee on a real conflict.
- [ ] 4.6 Add a parity test for the `theirs == base` and `ours == base`
  short-circuits.
- [ ] 4.7 Run nextest; record a regression name for every new test.

## 5. Network

- [ ] 5.1 Add a `network` feature flag in
  [pali/Cargo.toml](../../../../pali/Cargo.toml); pull in
  `gix/blocking-network-client` and
  `gix/blocking-http-transport-reqwest-rust-tls`.
- [ ] 5.2 Add `git_write::init_or_open` and rewrite `init_or_open_with_reporter`
  in [pali/src/repo.rs](../../../../pali/src/repo.rs) over it. Replace
  `Repository::init` with a `gix::init_into` equivalent.
- [ ] 5.3 Add `git_write::fetch(remote_name)` running inside
  `spawn_blocking`; build the `gix::Remote` inside the closure so the
  `!Send` return value never crosses a thread boundary.
- [ ] 5.4 Replace `FETCH_HEAD` reads (if any) by treating the
  `origin/<branch>` ref as the source of truth. Do not add a `FETCH_HEAD`
  writer (per crate-status.md, gix does not have one).
- [ ] 5.5 Build the credential path: reuse `build_auth_callbacks`,
  `normalize_git_token`, and `git_token` from
  [pali/src/repo.rs](../../../../pali/src/repo.rs). Wire the credential
  callback into gix's fetch transport; never place the token in the URL
  logged or stored on disk.
- [ ] 5.6 Add a `local_only` flag derived from `remote_names().is_empty()`
  at open time and a no-op path in `push` / `pull` when true.
- [ ] 5.7 Delete `MemoryRepo`'s `unsafe impl Send`/`unsafe impl Sync` at
  `repo.rs:259-260`. Confirm the code still compiles.
- [ ] 5.8 Add tests for: a fetch against `file://`; `local_only` skip push;
  local_only skip pull; URL redaction in error messages and logs.
- [ ] 5.9 Run `cargo tree -e features -i pali --features network` and
  verify the network client and rustls are present and OpenSSL is still
  only there for step 6.
- [ ] 5.10 Run nextest; record regression names.

## 6. Push

- [ ] 6.1 Add a `push_fallback` Cargo feature in
  [pali/Cargo.toml](../../../../pali/Cargo.toml) that brings in `git2`
  (and only `git2`) for the push call.
- [ ] 6.2 Add `git_write::push_via_subprocess(url, ref)` running
  `git push --porcelain --atomic` with `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_SYSTEM=/dev/null`, and the credential-helper override in
  D-5/R-2. Parse the porcelain output into a typed `PushStatus`.
- [ ] 6.3 Map the parsed status to `MemoryError::PushRejected` for
  `rejected` and to `MemoryError::Gix(_)` for `ok`-missing/transport
  errors.
- [ ] 6.4 Sanitize the URL before it reaches the subprocess: strip any
  userinfo from the URL string, supply the token through the credential
  helper, and never place the token in argv or environment beyond the
  scoped subprocess environment.
- [ ] 6.5 Add an `impl_push` feature-gated on `push_fallback` that falls
  back to git2's `Remote::push` with the existing `push_update_reference`
  callback (`repo.rs:729`) when the subprocess is unavailable.
- [ ] 6.6 Add unit tests for: porcelain parse (success, rejected,
  atomic-rollback, transport error); URL stripping; `local_only` skip.
- [ ] 6.7 Add an integration test that runs a real `git push` against
  `file://` (no network); assert `--porcelain --atomic` works as expected
  on the oldest supported git version.
- [ ] 6.8 Run nextest; record regression names.

## 7. Cleanup and verification

- [ ] 7.1 Run `cargo tree -e features -i pali`. Record the exact
  output with `push-fallback` enabled and with it disabled (a feature
  matrix). Confirm `vendored-openssl` is gone from the default build.
- [ ] 7.2 Confirm `MemoryError::Git` is gone; add `Gix(String)` at
  [pali/src/error.rs](../../../../pali/src/error.rs); confirm
  `MemoryError` is still `#[non_exhaustive]`.
- [ ] 7.3 Confirm no file outside [pali/src/git_read.rs](../../../../pali/src/git_read.rs)
  and [pali/src/git_write.rs](../../../../pali/src/git_write.rs) contains a
  `git2::` or `gix::` path.
- [ ] 7.4 Confirm `unsafe impl Send`/`unsafe impl Sync` on `MemoryRepo` is
  gone.
- [ ] 7.5 Run the full CI feature matrix locally:
  `--no-default-features`, default, `--features network, push-fallback`,
  `--all-features`.
- [ ] 7.6 Run `cargo deny check` and confirm the
  `docs/adr/0017-msrv-match-deps.md` and `docs/adr/0023-*` constraints still
  hold.
- [ ] 7.7 Run the public-API semver check with the same coverage as CI
  (default + explicit `otlp`). If the `MemoryError` change is breaking,
  flag for the version bump and CHANGELOG entry per `AGENTS.md`.
- [ ] 7.8 Run the differential parity harness end-to-end against a real
  memory repository rehearsal (hundreds of commits) and diff worktree,
  refs, packed objects, and logs.
- [ ] 7.9 Update [docs/architecture.md](../../../../docs/architecture.md),
  [docs/security.md](../../../../docs/security.md), and the
  [docs/adr/0053-gix-read-paths.md](../../../../docs/adr/0053-gix-read-paths.md)
  status line; add the ADR for the write path if step 0.4 has not already.
- [ ] 7.10 Run a focused independent code review (the review loop in
  `AGENTS.md`) on the exact head of the branch and resolve every finding
  at or above Low severity.

## 8. Open questions to close before/while coding

- [ ] 8.1 Quantify the vendored-openssl size after step 7.1; if smaller
  than the push parser, record it and revisit step 6.
- [ ] 8.2 Re-confirm subprocess push does not widen the credential-helper
  boundary beyond what ADR-0004 (no tokens in CLI args) and ADR-0010
  (keyring-based token storage) already require in the operator's deployment.
- [ ] 8.3 Re-read `conflicts_resolved` consumers from step 0.3 if the
  no-marker rule turns out to need different semantics; decide whether to
  keep `conflicts_resolved` always-false, retire it, or redefine it.
