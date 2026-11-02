# Design

## Transport Architecture (Before)

```text
                    ┌─────────────┐
                    │   pali      │
                    │  (process)  │
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
    │  stdio    │    │   HTTP    │    │   SSE     │
    │ transport │    │ transport │    │ transport │
    │  (rmcp)   │    │  (axum)   │    │  (axum)   │
    └───────────┘    └───────────┘    └───────────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                    ┌──────▼──────┐
                    │  MCP Core   │
                    └─────────────┘
```

## Transport Architecture (After)

```text
                    ┌─────────────┐
                    │   pali      │
                    │  (process)  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   stdio     │
                    │  transport  │
                    │   (rmcp)    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  MCP Core   │
                    └─────────────┘
```

## Removed Components

### src/health.rs

- `HealthServer` — Axum server with `/health`, `/ready`, `/metrics`
- `build_router()` — Router construction with tower-http layers
- `serve_health()` — Background task spawning HTTP server
- HTTP-specific metrics (request count, latency)

### src/main.rs

- CLI args: `--http`, `--port`, `--host`
- `k8s` feature gate and conditional compilation
- HTTP server startup/shutdown logic
- SessionManager HTTP integration

### src/server.rs

- `HttpServer` struct
- `handle_http()` — HTTP request handler
- `handle_sse()` — Server-sent events handler
- Session affinity logic for HTTP

### Cargo.toml

```toml
# Removed
[features]
k8s = ["axum", "tower", "tower-http"]

# Removed deps
axum = "0.7"
tower = "0.4"
tower-http = "0.5"
```

### Dockerfile

```dockerfile
# Removed
ENV HF_HOME=/models
ENV PORT=8080
EXPOSE 8080

# Removed
--features k8s
```

## Retained Components

### src/health.rs — SubsystemReporter

```rust
pub struct SubsystemReporter {
    // Structured logging for health
    // No HTTP, no network
}
```

Used by: embedding, search, vector store, git operations

### src/main.rs — Simplified

```rust
async fn main() -> Result<()> {
    let config = Config::load()?;
    warmup(&config).await?;  // Model warmup only
    serve_stdio(config).await  // Single transport
}
```

## Configuration Removal

| Config | Before | After |
| -------- | -------- | ------- |
| `http.enabled` | bool | Removed |
| `http.host` | String | Removed |
| `http.port` | u16 | Removed |
| `k8s.enabled` | bool | Removed |
| `health.endpoint` | String | Removed |

## Testing Impact

- Removed: HTTP integration tests
- Removed: SSE connection tests
- Retained: stdio transport tests (`tests/stdio.rs`)
- Retained: Unit tests for core logic
