# ADR-0047: Stdio as the only MCP transport

## Status
Accepted

## Context
ADR-0045 added stdio alongside Streamable HTTP, with HTTP as the default. In
practice every consumer drives Pali as a local subprocess over stdio: the
session-capture and digest hooks, MCP clients that cannot reach a host port, and
the documented client configurations. The HTTP server was the only thing keeping
`axum`, `tokio-util`, the MCP session manager, the HTTP health endpoints, and
the Kubernetes deployment manifests in the tree.

Removing it removes a whole class of operational surface — an unauthenticated
network listener, Host-header validation, session caps, rate limits, idle and
lifetime timeouts, readiness semantics, and a cluster deployment path — none of
which served the local-first, single-user usage Pali has.

Alternatives considered:

1. **Keep both transports** (status quo). Rejected: two serve paths, HTTP-only
   session/health machinery, and a network listener with no consumer.
2. **Keep HTTP as an opt-in feature flag.** Rejected: feature-gated transport
   still requires every HTTP-only flag, endpoint, and session type to exist and
   stay green in CI for a path nobody runs.
3. **Remove HTTP and serve stdio only.** Chosen.

## Decision
`pali serve` serves one MCP session over stdin/stdout and nothing else.

- Deleted: the `Transport` enum and `--transport`/`PALI_TRANSPORT`,
  `--bind`/`PALI_BIND`, `--mcp-path`/`PALI_PATH`, `--allowed-host`/
  `PALI_ALLOWED_HOST`, the session flags (`--max-sessions`,
  `--session-rate-limit`, `--session-rate-window-secs`, `--idle-timeout-secs`,
  `--max-session-lifetime-secs`), and `--health-stale-secs`.
- Deleted: the `session` module and its `BoundedSessionManager`, the
  `/healthz`, `/readyz`, and `/version` routes, and the `deploy/k8s`
  manifests.
- Deleted dependencies: `axum`, `tokio-util`, the rmcp
  `transport-streamable-http-server` feature, and the `tower` dev-dependency.
- The `require-remote-sync` flag keeps its startup meaning — pull every
  repository before index freshness is decided — and no longer feeds a
  readiness endpoint.
- Passive subsystem reporters remain on `AppState`; they are recorded state
  with no HTTP surface.
- Federation was the only consumer of a Streamable HTTP client. ADR-0050
  removes federation and that client; stdio remains the only transport.

## Consequences
- One transport, one code path, and a smaller dependency graph.
- No daemon mode, no port, no health endpoint, and no in-cluster deployment:
  each concurrent client launches its own process, and a container is used with
  `docker run -i` so the client owns the pipes.
- No session identity from the transport. Tracing and recall attribution label
  the session `stdio`; the process *is* the session.
- Kubernetes probes, Service, Ingress, and RBAC manifests are removed with the
  listener; ADR-0014's container build survives, but its `/healthz` probe clause
  does not.
- The `k8s` feature (token in a Kubernetes Secret) survived the transport
  removal unchanged; it is removed separately by ADR-0048, because the
  in-cluster deployment it served no longer exists.
- Supersedes ADR-0045.
