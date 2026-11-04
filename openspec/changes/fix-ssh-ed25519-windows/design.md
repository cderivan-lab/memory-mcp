# Design

## Context

- ADR-0046 (Accepted) enables git2's `ssh` feature with a vendored libssh2
  and a transport-aware credential callback (default key file → ssh-agent).
  That ADR was validated on platforms where libssh2's OpenSSL backend is the
  default (Linux/macOS); Windows was never exercised with an ed25519 key.
- Root cause (confirmed 2026-11-04): `libssh2-sys`'s `build.rs` compiles the
  vendored libssh2 with `LIBSSH2_WINCNG` on Windows unless the
  `openssl-on-win32` feature is set. The WinCNG backend (`wincng.c`)
  implements only MD5/SHA1/SHA2-3/5 and RSA — zero ed25519 code. libssh2
  therefore cannot sign an ed25519 userauth request, and the server rejects
  the session before the key is offered. System `ssh` (OpenSSH) works with
  the same key, which is why the failure is invisible outside Pali.
- `libgit2-sys` 0.18.8 does not forward an `openssl-on-win32` feature, so
  the flag must be set on `libssh2-sys` directly from `pali/Cargo.toml`.
- `libssh2-sys`'s `openssl-on-win32` feature activates its `openssl-sys`
  dependency, and ADR-0023 already vendors OpenSSL unconditionally
  (`openssl-sys` with `features = ["vendored"]`), so no new crate enters
  the tree — the same vendored OpenSSL that libgit2's HTTPS transport
  already links.
- `git2` is mandated by Accepted ADR-0002; shelling out to `git` for SSH
  remains rejected.

## Goals / Non-Goals

**Goals:**
- ed25519 (and RSA) SSH key authentication works on Windows with the
  existing credential fallback (default key file, then ssh-agent).
- Zero new dependencies; ADR-0023's vendoring/MSRV constraints preserved.
- Non-Windows builds and HTTPS token sync are byte-for-byte unchanged in
  behavior.
- The Accepted ADR-0046 is amended so the Windows constraint is binding
  context for future dependency bumps.

**Non-Goals:**
- No changes to credential resolution order, token handling, or host-key
  verification policy.
- No support for passphrase-protected keys without an agent (still out of
  scope per ADR-0046).
- No changes to the VS Code extension or hooks.

## Decisions

1. **Enable `libssh2-sys/openssl-on-win32` on Windows targets only.**
   In `pali/Cargo.toml`, move the `libssh2-sys` dependency into a
   `[target.'cfg(windows)'.dependencies]` entry alongside the existing
   `git2` `ssh` feature (git2's `ssh` feature enables `libssh2-sys`
   optionally; a direct target-scoped dep with the feature is additive and
   feature-unions with git2's). Alternative considered: patching
   `libgit2-sys` to forward the feature — rejected, it means maintaining a
   fork of a first-party crate for one flag.
2. **Amend ADR-0046 rather than a new ADR.** The decision is a platform
   constraint of the already-Accepted SSH-remotes decision, not a new
   alternative set. The amendment records: WinCNG lacks ed25519; the
   OpenSSL backend is mandatory on Windows; the feature must be re-checked
   on any `libssh2-sys`/`libgit2-sys` bump.
3. **Verification strategy.**
   - Unit: extend the existing `push_to_ssh_remote_uses_ssh_credentials`
     regression (transport-reaches, not credential-setup) with a Windows-
     specific assertion that the build defines the OpenSSL backend — e.g. a
     compile-time `#[cfg(all(windows, ...))]` guard test, or a build-script
     smoke test that fails CI if `LIBSSH2_WINCNG` is defined on Windows.
   - Integration (this machine): `pali serve --require-remote-sync` against
     `git@cc-github.bmwgroup.net:clebsonderivan/Memory.git` with the
     operator's ed25519 key must pull cleanly; the MCP `sync` tool must
     report success.
   - Full suite per AGENTS.md: `cargo nextest run --workspace --no-fail-fast`
     plus default and all-features combinations, `cargo deny`, MSRV check.

## Risks / Trade-offs

- **Build-time coupling**: Windows builds now compile libssh2 against
  vendored OpenSSL. If a future `libssh2-sys` release changes the
  `openssl-on-win32` wiring, the build breaks loudly (compile error), which
  is acceptable — silent WinCNG fallback is what caused this bug.
- **Binary size**: libssh2 gains OpenSSL-linked code paths on Windows; the
  vendored OpenSSL is already linked, so the delta is small.
- **CVE surface**: unchanged — the same vendored OpenSSL version is used;
  Dependabot monitoring per ADR-0023 still applies.
- **Feature-unification subtlety**: `git2/ssh` pulls `libssh2-sys` as
  optional; adding a direct `cfg(windows)` dep with
  `features = ["openssl-on-win32"]` must be verified to union correctly
  (cargo feature unification across optional + direct deps is standard, but
  the first build on a clean Windows CI leg is the proof).
