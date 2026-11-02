# Specification: Session Management

## Scope

Session lifecycle management for MCP stdio transport.

## Requirements

### REQ-101: Session Creation
- **ID**: REQ-101
- **Description**: `SessionManager::spawn(config)` creates new session with unique ID
- **Rationale**: Track each stdio connection independently

### REQ-102: Session Retrieval
- **ID**: REQ-102
- **Description**: `SessionManager::get(id)` returns `Option<Session>`
- **Rationale**: Lookup session by ID for request routing

### REQ-103: Session Touch
- **ID**: REQ-103
- **Description**: `SessionManager::touch(id)` updates last_accessed timestamp
- **Rationale**: Track activity for TTL expiration

### REQ-104: Session Termination
- **ID**: REQ-104
- **Description**: `SessionManager::terminate(id)` marks session terminated
- **Rationale**: Explicit cleanup on client disconnect

### REQ-105: Expiration Cleanup
- **ID**: REQ-105
- **Description**: `SessionManager::cleanup_expired(ttl)` removes stale sessions
- **Rationale**: Prevent memory leak from abandoned connections

### REQ-106: Thread Safety
- **ID**: REQ-106
- **Description**: All operations safe for concurrent access
- **Rationale**: Multiple stdio connections handled simultaneously

## Session State Machine

```
        spawn()
   ┌─────────────┐
   │   Active    │◄────────── touch()
   └──────┬──────┘
          │ terminate()
          ▼
   ┌─────────────┐
   │ Terminated  │
   └──────┬──────┘
          │ cleanup_expired()
          ▼
      (removed)
```

## Data Structures

```rust
pub struct Session {
    id: SessionId,                    // UUID v4
    created_at: SystemTime,           // Immutable
    last_accessed: RwLock<SystemTime>,// Updated on touch()
    state: RwLock<SessionState>,      // Active | Terminated
}

pub enum SessionState {
    Active,
    Terminated,
}
```

## Acceptance Criteria

- [ ] `SessionManager::new()` creates empty manager
- [ ] `spawn()` returns unique SessionId each call
- [ ] `get(id)` returns `Some` for active, `None` for missing/terminated
- [ ] `touch(id)` updates last_accessed for active sessions
- [ ] `terminate(id)` transitions state to Terminated
- [ ] `cleanup_expired(ttl)` removes sessions with last_accessed > ttl ago
- [ ] Concurrent spawn/get/touch/terminate from multiple threads succeeds