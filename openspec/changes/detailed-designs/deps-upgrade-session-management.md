# Detailed Design: Dependency Upgrade and Session Management

## Change: deps-upgrade-session-management

### Purpose

Upgrade outdated dependencies and add session lifecycle management for MCP stdio transport state tracking.

### Dependency Upgrades

- rmcp: 1.1 → 3.8 (MCP protocol 2025-06-18 support)
- reqwest: 0.12 → 0.13 (hyper 1.x, rustls 0.23)
- candle: 0.10 → 0.11 (new tokenizer API, CUDA 12+)
- tantivy: 0.26 → 0.27 (new segment API, faster indexing)
- keyring: 3 → 4 (new entry API, Windows WebAuthn)

### Removed Dependencies

- hf-hub: Removed (manual model download via script)
- axum: Removed (stdio-only per ADR-0047)
- http: Removed (unused after stdio-only)
- futures-core: Removed (unused after stdio-only)

### New Dependencies

- libc 0.2: For O_NOFOLLOW on unix (cfg-gated)

### Session Management Design

#### New: `src/session.rs`

- Session struct with id, created_at, last_accessed, state
- SessionManager with spawn, get, touch, terminate, cleanup
- In-memory storage with TTL-based expiration
- Thread-safe with RwLock

#### Integration Points

- src/main.rs: Session manager initialization at startup
- src/server.rs: Session manager integrated for stdio transport

### Design Rationale

- Session management enables future multi-session stdio support
- TTL-based expiration prevents memory leaks
- In-memory storage keeps things simple; can be persisted later
- API breaking changes absorbed internally
- Minimum Rust version unchanged (1.95+)
