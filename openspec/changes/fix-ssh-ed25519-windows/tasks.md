# Tasks

## Implementation

- [x] `pali/Cargo.toml`: add `cfg(windows)`-scoped `libssh2-sys` dependency
      with `features = ["openssl-on-win32"]` (feature-unions with git2's
      `ssh`-enabled libssh2)
- [x] Verify feature unification on a clean build:
      `cargo check -p pali` (Windows) and confirm libssh2 compiles with
      `LIBSSH2_OPENSSL` (not `LIBSSH2_WINCNG`) — inspect
      `target/*/build/libssh2-sys-*/output` for the define (verified via
      regression guard test below)
- [x] Add a regression guard so a future dependency bump cannot silently
      revert to WinCNG on Windows (build-script smoke test or cfg-gated
      compile test; name the regression: "ed25519 SSH auth on Windows")
- [x] `cargo fmt`, `cargo clippy -- -D warnings`, `cargo doc --no-deps`
      clean

## Verification (per AGENTS.md)

- [x] `cargo check -p pali` (default features) - compiles
- [x] `cargo check -p pali --all-features` - compiles
- [x] Feature combinations: default and all-features (`--all-features`) - both compile successfully.
- [x] `cargo nextest run --workspace --no-fail-fast` - same test results as base branch
      (20 pre-existing flaky test failures unrelated to this change)
- MSRV preserved; `cargo deny` checks pass
- Integration on this machine: requires SSH remote access for full verification
- Rebuild + stage the binary (`npm run build:binary`) and confirm the
  MCP `sync` tool succeeds end-to-end (pull + push)

## Documentation

- [x] Amend `docs/adr/0046-ssh-git-remotes.md`: record the Windows
      WinCNG/ed25519 constraint and the `openssl-on-win32` decision as an
      amendment (keep Accepted status; note re-check on libssh2-sys bumps)
- [x] `docs/security.md` + `docs/getting-started.md`: note ed25519 SSH
      support on Windows
- [x] `CHANGELOG.md` entry (Unreleased): fix line for Windows SSH sync

## Review

- [-] Review-fix loop, then independent certification review of the exact
      head (per AGENTS.md code-review process)
