# Detailed Design: ed25519 SSH Authentication on Windows

## Change: fix-ssh-ed25519-windows

### Problem Statement

On Windows, `pali serve` cannot authenticate to SSH git remotes with ed25519 keys. The vendored libssh2 is compiled with the WinCNG crypto backend, which implements only RSA/DSA/ECDSA and has no ed25519 support. This causes all SSH pull/push operations to fail with `failed to authenticate SSH session`.

### Root Cause

- `libssh2-sys`'s `build.rs` compiles the vendored libssh2 with `LIBSSH2_WINCNG` on Windows unless the `openssl-on-win32` feature is set
- The WinCNG backend (`wincng.c`) implements only MD5/SHA1/SHA2-3/5 and RSA — zero ed25519 code
- `libgit2-sys` 0.18.8 does not forward an `openssl-on-win32` feature
- The same key works with system `ssh` (OpenSSH), proving the issue is transport-layer, not key-format

### Solution

Enable the `openssl-on-win32` feature on `libssh2-sys` for Windows targets only, which connects to the vendored OpenSSL already present in the dependency tree (ADR-0023).

### Changes

#### 1. `pali/Cargo.toml` — Platform-Scoped Dependency

```toml
# Existing git2 dependency (already has ssh feature)
git2 = { version = "0.21.0", features = ["ssh"] }

# Windows-only libssh2-sys with OpenSSL backend
[target.'cfg(windows)'.dependencies]
libssh2-sys = { version = "0.28", features = ["openssl-on-win32"] }
```

**Rationale**: Moving `libssh2-sys` into a `cfg(windows)` section ensures:

- Non-Windows builds remain byte-for-byte unchanged
- Feature unification with git2's optional `libssh2-sys` works correctly
- No new crate enters the tree — same vendored OpenSSL as HTTPS transport

#### 2. ADR-0046 Amendment

Amend `docs/adr/0046-ssh-git-remotes.md` to record the Windows constraint:

- WinCNG lacks ed25519 support
- OpenSSL backend is mandatory on Windows
- The feature must be re-checked on any `libssh2-sys`/`libgit2-sys` bump

**Amendment text**: "On Windows targets, the `libssh2-sys` dependency must include the `openssl-on-win32` feature to enable ed25519 (and modern KEX) support. The WinCNG backend does not support ed25519 signing."

#### 3. Documentation Updates

- `docs/security.md`: Note that SSH remotes on Windows work with ed25519 keys via default key file or ssh-agent
- `docs/getting-started.md`: Document ed25519 SSH support on Windows
- `CHANGELOG.md`: Add unreleased entry for Windows SSH sync fix

#### 4. Verification Strategy

- **Unit**: Extend regression test with `#[cfg(all(windows, ...))]` guard test that asserts the build defines `LIBSSH2_OPENSSL` (not `LIBSSH2_WINCNG`) on Windows
- **Integration**: `pali serve --require-remote-sync` against `git@cc-github.bmwgroup.net:clebsonderivan/Memory.git` with operator's ed25519 key must pull cleanly
- **Full suite**: `cargo nextest run --workspace --no-fail-fast` with default and all-features; `cargo deny` checks pass; MSRV preserved

#### 5. Risks / Trade-offs

- **Build-time coupling**: Windows builds now compile libssh2 against vendored OpenSSL; if future `libssh2-sys` release changes the `openssl-on-win32` wiring, the build breaks loudly (compile error) — acceptable since silent WinCNG fallback caused this bug
- **Binary size**: libssh2 gains OpenSSL-linked code paths on Windows; vendored OpenSSL already linked, so delta is small
- **CVE surface**: Unchanged — same vendored OpenSSL version; Dependabot monitoring per ADR-0023 still applies
- **Feature-unification subtlety**: Must verify cargo feature unification across optional + direct deps works correctly on first Windows CI leg

### Non-Goals

- No changes to credential resolution order, token handling, or host-key verification policy
- No support for passphrase-protected keys without an agent (still out of scope per ADR-0046)
- No changes to the VS Code extension or hooks

### Success Criteria

- [ ] `pali serve` with ed25519 key works on Windows
- [ ] `pali sync` with SSH remote works on Windows
- [ ] No behavioral changes on non-Windows platforms
- [ ] `cargo deny` passes with no new violations
- [ ] MSRV (1.95+) preserved
