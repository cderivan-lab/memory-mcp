# Proposal

## Why

The dependency set was outdated (rmcp 1.1, reqwest 0.12, candle 0.10, tantivy 0.26, keyring 3, hf-hub 0.11) and the codebase lacked session lifecycle management. Upgrading brings security fixes, performance improvements, and API modernization. Session management is needed for MCP stdio transport state tracking.

## What Changes

- **Cargo.toml/Cargo.lock**: Major dependency upgrades:
  - rmcp 1.1 → 3.8 (MCP protocol 2025-06-18 support)
  - reqwest 0.12 → 0.13 (hyper 1.x, rustls 0.23)
  - candle 0.10 → 0.11 (new tokenizer API, CUDA 12+)
  - tantivy 0.26 → 0.27 (new segment API, faster indexing)
  - keyring 3 → 4 (new entry API, Windows WebAuthn)
  - Removed: hf-hub, axum, http, futures-core (unused after stdio-only)
  - Added: libc 0.2 (for O_NOFOLLOW on unix)

- **src/session.rs** (NEW): Session lifecycle management
  - `Session` struct with id, created_at, last_accessed, state
  - `SessionManager` with spawn, get, touch, terminate, cleanup
  - In-memory storage with TTL-based expiration
  - Thread-safe with RwLock

- **src/main.rs**: Added session manager initialization
- **src/server.rs**: Integrated session manager for stdio transport

## Capabilities

### New Capabilities

- `session-management`: Full session lifecycle (create, track, expire, terminate)
- `rmcp-3.8`: Latest MCP protocol with stdio transport
- `candle-0.11`: Modern tokenizer and model loading

### Modified Capabilities

- `dependency-set`: All major crates upgraded to latest compatible versions

### Removed Capabilities

- `hf-hub-integration`: Removed (manual model download via script)
- `axum-http-transport`: Removed (stdio-only per ADR-0047)

## Impact

- Minimum Rust version unchanged (1.95+)
- Breaking API changes in rmcp, reqwest, candle absorbed internally
- New `libc` dependency only on unix (cfg-gated)
- Session manager enables future multi-session stdio support
- CI/build times may increase slightly due to newer deps
