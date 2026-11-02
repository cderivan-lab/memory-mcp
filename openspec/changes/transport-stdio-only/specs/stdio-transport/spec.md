# Specification: Stdio-Only Transport

## Scope

MCP transport layer — removal of HTTP/SSE, retention of stdio only.

## Requirements

### REQ-201: Remove HTTP Transport

- **ID**: REQ-201
- **Description**: Remove all axum-based HTTP server code
- **Rationale**: ADR-0047 mandates stdio-only

### REQ-202: Remove SSE Transport

- **ID**: REQ-202
- **Description**: Remove Server-Sent Events handler
- **Rationale**: Part of HTTP transport stack

### REQ-203: Remove k8s Feature

- **ID**: REQ-203
- **Description**: Remove `k8s` cargo feature and conditional compilation
- **Rationale**: HTTP-dependent Kubernetes deployment

### REQ-204: Simplify CLI

- **ID**: REQ-204
- **Description**: Remove `--http`, `--port`, `--host` arguments
- **Rationale**: No HTTP server to configure

### REQ-205: Simplify Docker

- **ID**: REQ-205
- **Description**: Remove EXPOSE 8080, HF_HOME, k8s feature from Dockerfile
- **Rationale**: No HTTP server in container

### REQ-206: Retain Passive Health

- **ID**: REQ-206
- **Description**: Keep `SubsystemReporter` for structured health logging
- **Rationale**: ADR-0006 requires observability without HTTP

### REQ-207: Retain Stdio Transport

- **ID**: REQ-207
- **Description**: `serve_stdio()` using rmcp stdio transport remains
- **Rationale**: Primary and only MCP transport

## Acceptance Criteria

- [ ] `cargo check` passes without axum/tower/tower-http
- [ ] `cargo test` passes (stdio tests only)
- [ ] `pali serve --help` shows no --http/--port/--host
- [ ] `pali serve` starts stdio transport successfully
- [ ] Docker build succeeds without HTTP port
- [ ] `SubsystemReporter` logs health to stdout/stderr
- [ ] No `k8s` feature in Cargo.toml
- [ ] No unused dependency warnings
