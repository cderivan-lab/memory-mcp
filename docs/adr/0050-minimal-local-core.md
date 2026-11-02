# ADR-0050: Minimal local core

## Status
Accepted

## Context

Pali's surface had grown past what its usage justified. Three subsystems
existed only for deployment shapes the project no longer targets:

- **Federation** (ADR-0044) let one store read the same name from trusted
  sibling stores. It required an outbound Streamable HTTP MCP client, sibling
  topology in configuration, per-caller bearer delegation, and a
  multi-store response envelope. Over stdio there is no inbound credential to
  delegate, so every straddled read returned `identity_unavailable` for each
  sibling — the feature was unreachable in the only transport Pali ships
  (ADR-0047).
- **OAuth device flow and credential storage** (ADR-0010, ADR-0012, ADR-0024)
  acquired a GitHub token, stored it in the keyring or a token file, and
  injected it into libgit2 callbacks. The `keyring` dependency brings a
  platform secret-service backend and, on Linux, a D-Bus system link — a large
  operational and build cost for a convenience git can already provide.
- **Container deployment and its build path** (ADR-0014, ADR-0049) produced a
  Dockerfile, a CI image build, a GHCR publish workflow, and Kubernetes-era
  guidance. Pali is a local stdio server: the client launches the process and
  owns its pipes, so packaging a daemon image added a second distribution
  channel with its own model-baking, attestation, and platform concerns.

The project's stated direction is a minimalist local tool: SQLite for the
recall log, git for storage, no network listener, no server-side identity.

## Decision

Remove federation, OAuth token handling, and container packaging.

Deleted:

- `src/federation.rs`, the `read` tool's `straddle` mode and multi-store
  response, and the `MemoryServer` federation topology.
- Configuration keys `store_id`, `siblings`, and `straddle_timeout_ms`, plus
  sibling endpoint validation.
- `src/auth/` — the OAuth device-flow provider, `AuthProvider`, keyring and
  token-file storage, and the `pali auth` subcommand.
- Cargo dependencies `keyring`, `secrecy`, and the rmcp `client` /
  `transport-streamable-http-client-reqwest` features. `reqwest` is now
  optional and only compiled for the `otlp` feature, which parses collector
  URLs.
- `Dockerfile`, `Dockerfile.ci`, `.dockerignore`, the `publish-image`
  workflow, and the image build job in CI.
- The GitHub Actions and Forgejo workflow files; formatting, lint, docs, and
  test gates now run from a local checkout.
- `MemoryError::Auth`, `OAuth`, and `TokenStorage`.

HTTPS git remotes now use libgit2's default credential acquisition, which
reads git's configured credential helpers and `~/.netrc`. SSH remotes keep the
existing key/agent callback. Pali no longer reads, stores, or forwards any
token itself.

## Consequences

- One local binary, one transport, and a smaller dependency graph: no D-Bus
  link, no HTTP client in default builds, no image publishing.
- Git credentials are the operator's responsibility through standard git
  configuration. `PALI_GITHUB_TOKEN`, the token file, and `pali auth` are
  gone; a private HTTPS remote needs a credential helper or `.netrc` entry.
- Breaking for Rust consumers: `MemoryServer::with_config`,
  `AppState::auth`, the `auth` module, `ReadToolArgs`, and several `Config`
  fields are removed, and `MemoryRepo::push`/`pull` plus
  `RepoRouter::sync_all`/`pull_all` no longer take an `AuthProvider`.
- Existing config files that still contain federation keys load fine: the
  unknown keys are ignored rather than rejected.
- Federation's custody model is not replaced. A caller that needs fragments
  from independent stores must contact each store itself, which keeps the
  authorization boundary explicit.
- ADR-0010, ADR-0012, ADR-0014, ADR-0024, and ADR-0044 are superseded.
  ADR-0047's stdio-only decision stands; its clause retaining a federation
  HTTP client no longer applies. ADR-0049's manual model provisioning stands;
  its Dockerfile clauses no longer apply.
