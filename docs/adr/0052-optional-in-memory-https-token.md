# ADR-0052: Optional in-memory HTTPS git token

## Status
Accepted

## Context

ADR-0050 removed OAuth, keyring storage, and the token file, leaving HTTPS git
remotes to libgit2's default credential acquisition (git credential helpers or
`~/.netrc`). That is the right default for a CLI process started from a shell,
where the operator's git configuration and environment are already in place.

It is not sufficient for every caller. The VS Code extension launches
`pali serve` from the editor's extension host, which does not inherit a
terminal's environment and cannot prompt through git's askpass. An operator
whose memory repository is a private HTTPS remote would otherwise have to
write a `.netrc` entry or install a credential helper just to sync, even
though they already hold a personal access token.

Alternatives considered:

1. **Keep credential-helper-only authentication.** Rejected: it leaves the
   extension's `remoteUrl` setting unusable with private HTTPS remotes, which
   is the common case for a shared memory repository.
2. **Embed the token in the remote URL.** Rejected: `MemoryRepo::init_or_open`
   stores the origin URL in the repository's git config, so the secret would be
   persisted to disk and would survive in plaintext for the life of the
   repository.
3. **Read an optional token from the environment and use it only inside the
   libgit2 credential callback.** Chosen.

## Decision

When `PALI_GIT_TOKEN` is set to a non-blank value, HTTPS remotes authenticate
with it. The value is read at connect time, trimmed, and turned into a
`userpass_plaintext` credential inside the credential callback only. The
username is taken from the remote URL when the operator supplied one
(`https://oauth2@gitlab.com/org/repo.git`), otherwise `x-access-token`, which
GitHub accepts for personal access tokens. A blank value behaves exactly like
an unset variable, so an empty environment entry never authenticates with an
empty password.

Without the variable, behaviour is unchanged: libgit2's credential helpers and
`~/.netrc`. SSH remotes are unaffected — the token never applies to them.

The token is never written to the repository config, logs, spans, or MCP
traffic, and it is not exported to child processes beyond the process that
received it. The VS Code extension exposes the variable as the `pali.pat`
setting and passes it to the server as `PALI_GIT_TOKEN`.

`PALI_REMOTE_URL` may also be an absolute path to a local or bare repository;
git resolves path remotes directly and no credential is involved.

## Consequences

- Private HTTPS remotes work from the extension host and from containers where
  a credential helper is absent; nothing is persisted.
- The token lives in the operator's environment or, for the VS Code extension,
  in VS Code's secret storage (the OS keychain) — never in `settings.json` or
  the memory repository.
- ADR-0050's absolute statement that Pali never reads or forwards a token is
  superseded for this explicit, in-memory case. Its removal of OAuth, keyring
  and token-file storage, `AuthProvider`, and `PALI_GITHUB_TOKEN` stands.
- A local path as `PALI_REMOTE_URL` is now a documented, tested remote form.
