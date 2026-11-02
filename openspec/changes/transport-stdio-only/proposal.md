# Proposal

## Why

The HTTP transport (axum-based) added complexity, security surface (TLS, CORS, auth), and maintenance burden. ADR-0047 mandates stdio-only transport for MCP servers. This commit removes all HTTP transport code and configuration.

## What Changes

### Removed (61 files touched)

- **src/health.rs**: HTTP handlers (`/health`, `/ready`, `/metrics`), Axum router, `HealthServer` struct
- **src/main.rs**: `--http`, `--port`, `--host` args; `k8s` feature; `SessionManager` HTTP integration; warmup HTTP endpoint
- **src/server.rs**: HTTP session handling, `HttpServer` struct, SSE transport
- **Cargo.toml**: `k8s` feature, axum, tower, tower-http dependencies
- **Dockerfile** / **Dockerfile.ci**: `HF_HOME`, `--features k8s`, HTTP port exposure
- **docs/**: `deployment.md` (k8s/HTTP sections), `configuration.md` (HTTP config), `security.md` (TLS sections), `architecture.md` (HTTP diagram)
- **README.md**: HTTP server usage, Docker HTTP examples
- **openspec/**: k8s-deployment, oauth-device-flow-HTTP specs archived

### Added/Modified

- **src/main.rs**: Simplified to `serve_stdio()` + `warmup()` only
- **src/health.rs**: Retained `SubsystemReporter` for passive health (ADR-0006)
- **docs/adr/0047-streamable-http-only.md**: ADR documenting decision
- **src/config.rs**: Removed `HttpConfig`, `K8sConfig`

## Capabilities

### Removed Capabilities
- `http-transport`: Axum-based HTTP/SSE MCP transport
- `k8s-deployment`: Kubernetes deployment with HTTP probes
- `http-health-endpoints`: `/health`, `/ready`, `/metrics` HTTP endpoints
- `oauth-device-flow-http`: OAuth device flow via HTTP callback

### Retained Capabilities
- `stdio-transport`: Standard MCP stdio transport (only transport)
- `passive-health`: SubsystemReporter for structured logging (ADR-0006)

## Impact

- **Breaking**: HTTP server no longer starts; `--http` flag removed
- **Breaking**: Docker images no longer expose HTTP port
- **Breaking**: k8s feature removed; k8s deployments must migrate to stdio
- **Simplification**: ~2000 lines removed, single transport path
- **Security**: Reduced attack surface (no TLS, no CORS, no HTTP auth)
- **Operations**: Simpler deployment (stdin/stdout only)