# ADR-0046: SSH Git Remotes Through libgit2

## Status
Accepted

Amended by [ADR-0052](0052-optional-in-memory-https-token.md): HTTPS token
authentication is `PALI_GIT_TOKEN` when set, otherwise git credential helpers
or `~/.netrc`. The keyring and token-file chain in the context below is
historical.

## Context
Remote sync authenticated only HTTPS remotes, with a personal access token
resolved from `PALI_GITHUB_TOKEN`, the token file, or the keyring (ADR-0010,
ADR-0012). The implementation compiled git2 without its SSH transport and
always supplied `userpass_plaintext`, so an `ssh://` remote — the native form
for self-hosted Gitea, Forgejo, and GitLab — could not authenticate at all.

Options:
1. Require HTTPS everywhere and document an SSH-to-HTTPS conversion.
2. Shell out to `git` for SSH remotes. Rejected: ADR-0002 chose libgit2 to
   avoid shell semantics, and the process would need its own credential UX.
3. Enable libgit2's SSH transport and select credentials by remote URL scheme.

## Decision
Enable git2's `ssh` feature (libgit2 with a vendored libssh2) and make the
credential callback transport-aware:

- `ssh://[user@]host[:port]/path` and scp-like `[user@]host:path` remotes use
  SSH credentials. The callback first tries the first existing default private
  key (`~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`) and, on libgit2's retry after
  a rejected attempt, falls back to `SSH_AUTH_SOCK` so agent-held and
  passphrase-protected keys work. The key path is passed to libgit2; Pali never
  reads key material.
- HTTP(S) remotes keep the existing token authentication.
- Token resolution is required only for HTTP(S) remotes. An SSH push or pull
  with no token configured proceeds to the transport instead of failing
  credential setup.

## Consequences
- One URL scheme decision in the credential callback; one dependency
  (`libssh2-sys`, BSD-3-Clause) added to the vendored native stack.
- SSH keys are not stored or copied by Pali. Authentication depends on the
  operator's key file or agent; a passphrase-protected key with no agent and
  no default key file still fails authentication.
- Host-key verification follows libgit2/libssh2 defaults; operators manage
  `known_hosts` expectations through their SSH configuration.
- The remote username comes from the URL (falling back to `git`), so
  self-hosted forges work without new configuration.
- Tokens remain usable for HTTP(S) only; no token is ever placed in a remote
  URL by Pali.
