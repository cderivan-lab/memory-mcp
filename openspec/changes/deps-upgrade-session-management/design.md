# Design

## Dependency Upgrade Strategy

Upgrades were done in a single commit to minimize intermediate breakage. Each crate was updated to latest semver-compatible version:

| Crate | Old | New | Breaking Changes |
| ------- | ----- | ----- | ------------------ |
| rmcp | 1.1 | 3.8 | Transport API, message types |
| reqwest | 0.12 | 0.13 | hyper 1.x, client builder |
| candle | 0.10 | 0.11 | Tokenizer API, Device changes |
| tantivy | 0.26 | 0.27 | Segment API, IndexWriter |
| keyring | 3 | 4 | Entry::get → get_password |

Removed crates (unused after stdio-only):

- hf-hub (model fetch now manual)
- axum (HTTP server removed)
- http (re-exported by rmcp)
- futures-core (re-exported by tokio)

Added:

- libc 0.2 (O_NOFOLLOW constant on unix)

## Session Management Architecture

```bash
┌─────────────────────────────────────┐
│         SessionManager              │
│  ┌─────────────────────────────┐   │
│  │   HashMap<SessionId, Session>  │◄── RwLock protected
│  └─────────────────────────────┘   │
│         ▲           ▲               │
│    spawn()    get()/touch()         │
│         │           │               │
│    terminate()  cleanup_expired()   │
└─────────────────────────────────────┘
```

### Session Struct

```rust
pub struct Session {
    id: SessionId,
    created_at: SystemTime,
    last_accessed: RwLock<SystemTime>,
    state: RwLock<SessionState>,
}
```

### SessionManager API

- `spawn(config) -> SessionId` — Create new session
- `get(id) -> Option<Session>` — Retrieve by ID
- `touch(id)` — Update last_accessed
- `terminate(id)` — Explicit termination
- `cleanup_expired(ttl)` — Remove stale sessions

## Thread Safety

- `RwLock<HashMap<...>>` for concurrent read/mutate
- `SessionState` enum: Active, Terminated
- `last_accessed` under separate RwLock for fine-grained locking

## Integration Points

- `main.rs`: `SessionManager::new()` at startup
- `server.rs`: Session tracking per stdio connection
- Future: MCP initialize/initialized notifications map to session spawn
