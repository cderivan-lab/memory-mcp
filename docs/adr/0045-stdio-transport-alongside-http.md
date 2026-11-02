# ADR-0045: Stdio Transport Alongside Streamable HTTP

## Status
Superseded by ADR-0047

> **Note:** The HTTP transport was removed; Pali now serves stdio only.

## Context
ADR-0001 chose Streamable HTTP as the sole transport, on the grounds that no
current MCP client required stdio and that HTTP on loopback achieved the same
thing. That premise no longer holds: MCP clients that launch a server as a
subprocess (and sandboxed clients that cannot reach a host port) speak stdio
only, and the documented workaround was an external `mcp-remote` bridge — a
second runtime and dependency between the client and Pali.

Both transports serve exactly the same tool handlers. The only transport-owned
behavior in the handlers was the `Mcp-Session-Id` header used to label tracing
spans and recall-log rows.

## Decision
Support stdio in addition to Streamable HTTP, selected with
`--transport`/`PALI_TRANSPORT` (default `http`).

- Stdio serves one connection for the process lifetime, using
  newline-delimited JSON-RPC on stdin/stdout. stdout carries only MCP frames;
  all tracing and diagnostics go to stderr.
- Startup (repository, embedding engine, indexes, lexical rebuild) and tool
  handling are shared with the HTTP transport; only the transport and the
  shutdown source differ (stdin EOF instead of a signal).
- Tool handlers take the request extensions rather than requiring
  `http::request::Parts`. HTTP requests still carry the parts and their session
  header; when a transport provides no HTTP metadata, the session label is
  `stdio`.
- HTTP-only concerns stay HTTP-only: health endpoints, allowed-host
  validation, session caps, rate limits, and idle/lifetime timeouts.

## Consequences
- Clients can launch `pali serve --transport stdio` directly; no bridge
  process is required.
- Two transports, one tool surface and one startup path. The only duplicated
  code is the serve call itself and the shutdown handling.
- Stdio has no per-request session identity. The process is the session, so
  tracing and recall attribution use a constant label, and concurrent clients
  cannot share one stdio process.
- Stdio has no authentication or readiness surface. Its trust boundary is the
  OS: the client can read the memory repository under the same user identity.
  HTTP keeps the loopback binding and gateway guidance in the security docs.
- Session tuning flags are accepted but unused on stdio; the help text says so
  rather than failing, so environment-driven deployments can switch transport
  without also pruning their configuration.
- ADR-0001 is superseded.
