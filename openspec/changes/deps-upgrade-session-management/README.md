# Dependencies: Upgrade + Session Management

Upgrades all major dependencies to latest versions and adds session lifecycle management for stdio transport.

## Files Modified

- `Cargo.toml` / `Cargo.lock` — Major version upgrades
- `src/main.rs` — SessionManager initialization
- `src/server.rs` — Session integration

## Files Added

- `src/session.rs` — Session lifecycle management (NEW)

## Dependency Changes

| Crate | Before | After | Notes |
| ------- | -------- | ------- | ------- |
| rmcp | 1.1 | 3.8 | MCP 2025-06-18, stdio transport |
| reqwest | 0.12 | 0.13 | hyper 1.x, rustls 0.23 |
| candle | 0.10 | 0.11 | New tokenizer, CUDA 12 |
| tantivy | 0.26 | 0.27 | Segment API, faster index |
| keyring | 3 | 4 | New Entry API, WebAuthn |
| hf-hub | 0.11 | — | Removed (manual model) |
| axum | 0.7 | — | Removed (stdio-only) |
| http | 0.2 | — | Removed (rmcp re-exports) |
| futures-core | 0.3 | — | Removed (tokio re-exports) |
| libc | — | 0.2 | Added (O_NOFOLLOW unix) |

## Session Management

```rust
// SessionManager API
let manager = SessionManager::new();
let id = manager.spawn(config);
let session = manager.get(id);
manager.touch(id);
manager.terminate(id);
manager.cleanup_expired(Duration::from_secs(3600));
```

- Thread-safe with RwLock
- TTL-based expiration
- Per-stdio-connection trackin
