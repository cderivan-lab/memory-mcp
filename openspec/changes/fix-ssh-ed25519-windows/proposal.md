# Proposal

## Why

On Windows, `pali serve` cannot authenticate to SSH git remotes with ed25519
keys — the common default for new `ssh-keygen` keys. The vendored libssh2 is
compiled with the WinCNG crypto backend, which implements only RSA/DSA/ECDSA
and has no ed25519 support, so every SSH pull/push fails with
`failed to authenticate SSH session`. The failure was confirmed end-to-end on
this machine (2026-11-04): system `ssh` authenticates with the same
passphrase-less `~/.ssh/id_ed25519`, but the installed `pali 1.0.1` binary
fails identically in a direct `serve --require-remote-sync` run and in the
MCP `sync` tool. SSH remotes were introduced as a first-class, token-free
sync path (ADR-0046); on Windows with ed25519 keys that path is dead.

## What Changes

- `pali/Cargo.toml`: enable the `openssl-on-win32` feature on `libssh2-sys`
  (Windows targets only) so the vendored libssh2 is built against the
  vendored OpenSSL already present in the dependency tree (ADR-0023) instead
  of WinCNG. This gives libssh2 ed25519 (and modern KEX) support on Windows.
- `pali/src/repo.rs`: no credential-logic changes expected; the existing
  key-file/agent fallback (ADR-0046) must continue to work unchanged.
- `docs/adr/0046-ssh-git-remotes.md`: amend the Accepted ADR to record the
  Windows crypto-backend decision (WinCNG cannot sign ed25519; OpenSSL
  backend is required there).
- `docs/security.md` / `docs/getting-started.md`: note that SSH remotes on
  Windows work with ed25519 keys via the same default-key/agent path.
- Rebuild and re-stage the Windows binary (`npm run build:binary`) so the
  packaged/installed server picks up the new libssh2 build.

## Capabilities

### New Capabilities

- `ssh-remote-sync`: Git remote sync over SSH — which key types and
  credential sources (default key file, ssh-agent) authenticate on each
  platform, and the failure behavior when the transport cannot sign with the
  operator's key.

### Modified Capabilities

(none — the three existing specs `copilot-session-capture`,
`repository-scanner`, and `workspace-bootstrap` are unaffected)

## Impact

- **Dependencies**: no new crates; `libssh2-sys` gains the
  `openssl-on-win32` feature, which activates its existing (already
  vendored) `openssl-sys` Windows dependency. No MSRV impact (build-time
  feature only). Must pass `cargo deny` and preserve ADR-0023's vendoring
  constraints.
- **Behavior**: SSH remotes on Windows go from "always fails with ed25519
  keys" to working with the operator's default key or agent. HTTPS token
  sync and non-Windows SSH behavior are unchanged.
- **Build**: Windows builds compile libssh2 against vendored OpenSSL instead
  of WinCNG; binary size and build time change slightly.
- **Artifacts**: a rebuilt `pali.exe` must ship (release workflow /
  `build-binaries.yml`) for the fix to reach installed users.
