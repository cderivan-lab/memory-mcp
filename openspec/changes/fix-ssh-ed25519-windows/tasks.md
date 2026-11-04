# Tasks

## Implementation

- [ ] `pali/Cargo.toml`: add `cfg(windows)`-scoped `libssh2-sys` dependency
      with `features = ["openssl-on-win32"]` (feature-unions with git2's
      `ssh`-enabled libssh2)
- [ ] Verify feature unification on a clean build:
      `cargo check -p pali` (Windows) and confirm libssh2 compiles with
      `LIBSSH2_OPENSSL` (not `LIBSSH2_WINCNG`) — inspect
      `target/*/build/libssh2-sys-*/output` for the define
- [ ] Add a regression guard so a future dependency bump cannot silently
      revert to WinCNG on Windows (build-script smoke test or cfg-gated
      compile test; name the regression: "ed25519 SSH auth on Windows")
- [ ] `cargo fmt`, `cargo clippy -- -D warnings`, `cargo doc --no-deps`
      clean

## Verification (per AGENTS.md)

- [ ] `cargo nextest run --workspace --no-fail-fast` (canonical full suite)
- [ ] Feature combinations: default and all-features (`--all-features`)
- [ ] MSRV preserved; `cargo deny` checks pass
- [ ] Integration on this machine:
      `pali serve --repo-path ~/.memory-mcp --remote-url
      git@cc-github.bmwgroup.net:clebsonderivan/Memory.git --branch main
      --require-remote-sync` pulls cleanly with the ed25519 default key
- [ ] Rebuild + stage the binary (`npm run build:binary`) and confirm the
      MCP `sync` tool succeeds end-to-end (pull + push)

## Documentation

- [ ] Amend `docs/adr/0046-ssh-git-remotes.md`: record the Windows
      WinCNG/ed25519 constraint and the `openssl-on-win32` decision as an
      amendment (keep Accepted status; note re-check on libssh2-sys bumps)
- [ ] `docs/security.md` + `docs/getting-started.md`: note ed25519 SSH
      support on Windows
- [ ] `CHANGELOG.md` entry (Unreleased): fix line for Windows SSH sync

## Review

- [ ] Review-fix loop, then independent certification review of the exact
      head (per AGENTS.md code-review process)
