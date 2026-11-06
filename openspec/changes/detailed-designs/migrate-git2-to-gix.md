# Detailed Design: Migrate git2 to gix

## Change: migrate-git2-to-gix

### Purpose

Migrate the `pali` git2 dependency to gix, starting with read-only operations and eventually replacing push with a subprocess fallback. The goal is to delete vendored OpenSSL from the dependency tree.

### New Capabilities

#### `git-backend-gix`

- Read-only git operations (open, init, HEAD, blame, status, untracked enumeration, tree/blob diffing, merge-base) through gix
- gix type surface confined to `git_read.rs` and the new `git_write.rs` seam
- Differential parity harness against libgit2 reference

#### `local-only-repo`

- Mutation path that runs with no network client when the repository has no configured remote
- Push is skipped, not attempted

#### `push-via-subprocess`

- Push performed through `git push --porcelain --atomic`
- git2 retained only as fallback when the git binary is unavailable

### Design Decisions

#### Phase 1: Scanner Migration (Step 1)

Replace git2 with gix on read paths in `pali/src/scanner.rs`:

- `Repository::open` → `git_read::open_repo` helper
- `head_commit` → `head_sha` plus `git_read::commit_subject`
- `commit_messages` → over `git_read::commit_walking` (same ordering, 5-entry bound)
- `list_paths` → over `git_read::git_read`, honoring `.gitignore`, never following nested repos
- `blame_lines` → over `gix::annotate::blame`; emit commit IDs and line numbers only

#### Phase 2: Pure-Tree Commits (Step 2)

Add `pali/src/git_write.rs` with:

- `write_memory_tree(head, path, content) -> new_tree`: reads HEAD tree (or empty tree for unborn HEAD), applies one-path overlay, prunes empty parents, writes resulting tree
- `commit_at(head_commit, tree, message, signature) -> new_commit`: creates commit CAS ref
- `regenerate_index(tree)`: writes libgit2-and-git CLI compatible `.git/index` from just-written tree (developer convenience only)
- Rewrite `save_memory` in `repo.rs` to use: read HEAD → `write_memory_tree` → `commit_at` → CAS
- Rewrite `delete_memory` and `move_memory` similarly
- Delete `index_from_head`, `stage_add`, `stage_remove`, `commit_index` from `repo.rs`
- Delete `git2::Index`/`Oid` types from `repo.rs` (keep narrow `use git2::...` for remaining types)

#### Phase 3: Worktree Materialization (Step 3)

- `git_write::materialize_from_tree(tree, path_filter)`: walks new tree, reads each blob, writes file through existing `write_memory_file`
- Refuses any path where `write_memory_file`'s `assert_within_root`, symlink walk, `O_NOFOLLOW` probe, or `atomic_write` rejects
- Replace `checkout_head(force)` with `materialize_from_tree` in rollback path and anywhere `CheckoutBuilder::default().force()` appears

#### Phase 4: Three-Way Merge (Step 4)

- `git_write::merge_trees(ours, theirs, base, by_updated_at)`: D-2 rule (ours==theirs→keep; ours==base→theirs; theirs==base→ours; else newer `updated_at` wins, ties→ours)
- Rewrite `merge_with_remote` at `repo.rs:769`: fetch → compute base = merge-base → `merge_trees` → write single commit (or fast-forward if `ours` ancestor of `theirs`)
- Delete `resolve_conflicts_by_recency`, `conflict_remove`, `cleanup_state` paths
- Add `pull` as `fetch → merge_trees → materialize`; keep `MemoryError::PushRejected` for genuine divergence

#### Phase 5: Network Operations (Step 5)

- Add `network` feature flag in `pali/Cargo.toml`: pulls in `gix/blocking-network-client` and `gix/blocking-http-transport-reqwest-rust-tls`
- Rewrite `init_or_open` and `init_or_open_with_reporter` over gix
- `git_write::fetch(remote_name)` inside `spawn_blocking`; build `gix::Remote` inside closure so `!Send` never crosses thread boundary
- Credential path: reuse `build_auth_callbacks`, `normalize_git_token`, `git_token` from `repo.rs`; wire into gix's fetch transport; never place token in URL logged or stored on disk
- `local_only` flag derived from `remote_names().is_empty()` at open time; no-op path in `push`/`pull` when true
- Delete `MemoryRepo`'s `unsafe impl Send`/`unsafe impl Sync` at `repo.rs:259-260`

#### Phase 6: Push Fallback (Step 6)

- Add `push_fallback` Cargo feature: brings in `git2` (and only `git2`) for push call
- `git_write::push_via_subprocess(url, ref)`: runs `git push --porcelain --atomic` with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, credential-helper override
- Parse porcelain output into typed `PushStatus`
- Map status: `rejected` → `MemoryError::PushRejected`; `ok`-missing/transport errors → `MemoryError::Gix(_)`
- URL sanitization: strip userinfo from URL string, supply token through credential helper, never place token in argv or environment beyond scoped subprocess environment
- `impl_push` feature-gated on `push_fallback` falls back to git2's `Remote::push` with existing `push_update_reference` callback when subprocess unavailable

#### Phase 7: Cleanup and Verification (Step 7)

- `cargo tree -e features -i pali`: record output with `push-fallback` enabled and disabled; confirm `vendored-openssl` gone from default build
- `MemoryError::Git` gone; add `Gix(String)` at `pali/src/error.rs`; confirm `MemoryError` is still `#[non_exhaustive]`
- No file outside `pali/src/git_read.rs` and `pali/src/git_write.rs` contains `git2::` or `gix::` path
- `unsafe impl Send`/`unsafe impl Sync` on `MemoryRepo` is gone
- Full CI feature matrix locally: `--no-default-features`, default, `--features network, push-fallback`

### Breaking Changes

- Public `MemoryError` enum shape changes
- `push` is no longer a first-class gix capability and is gated behind `push-fallback` feature
- `MemoryError::Git(#[from] git2::Error)` becomes `MemoryError::Gix(String)`
- Error code classifications (`NotFound`, `NonFastforward`) lost at API boundary and must be re-derived from gix's error kind

### Verification

- Unit tests for every git2 save, delete, and move producing same tree, ref, and worktree bytes as gix version
- Integration tests for: fetch against `file://`; `local_only` skip push; local_only skip pull; URL redaction
- Parity harness extending `gix_untracked_enumeration_matches_libgit2` to cover commits, merges, and checkouts
- Nextest: default and all-features combinations; feature matrix locally
