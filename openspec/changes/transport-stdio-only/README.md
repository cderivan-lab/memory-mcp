# Transport: Remove HTTP, Stdio-Only

Removes all HTTP transport code (axum, SSE) per ADR-0047. Only MCP stdio transport remains.

## Files Removed

- `src/health.rs` — HTTP handlers, Axum router, HealthServer
- `src/server.rs` — HttpServer, SSE handler, HTTP session logic
- Cargo.toml: `k8s` feature, axum, tower, tower-http deps
- Dockerfile: HTTP port, HF_HOME, k8s feature

## Files Modified

- `src/main.rs` — Simplified to `serve_stdio()` + `warmup()`
- `src/health.rs` — Retained `SubsystemReporter` only
- `src/config.rs` — Removed `HttpConfig`, `K8sConfig`
- `docs/deployment.md` — Removed k8s/HTTP deployment
- `docs/configuration.md` — Removed HTTP config
- `docs/security.md` — Removed TLS/CORS sections
- `docs/architecture.md` — Simplified transport diagram
- `README.md` — Removed HTTP usage examples

## Files Added

- `docs/adr/0047-streamable-http-only.md` — ADR documenting decision

## Breaking Changes

- `--http`, `--port`, `--host` CLI flags removed
- Docker no longer exposes port 8080
- `k8s` feature removed
- HTTP health endpoints (`/health`, `/ready`, `/metrics`) removed

## Usage

```bash
# Before (no longer works)
pali serve --http --port 8080

# After (only option)
pali serve  # stdio transport
```

## Docker

```dockerfile
# Before
EXPOSE 8080
ENV HF_HOME=/models
CMD ["pali", "serve", "--http", "--port", "8080"]

# After
CMD ["pali", "serve"]
```
