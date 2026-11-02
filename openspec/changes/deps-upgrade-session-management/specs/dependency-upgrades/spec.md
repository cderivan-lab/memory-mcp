# Specification: Dependency Upgrades

## Scope

Rust crate dependency upgrades and removals.

## Requirements

### REQ-001: rmcp 3.8
- **ID**: REQ-001
- **Description**: Upgrade rmcp from 1.1 to 3.8
- **Rationale**: MCP protocol 2025-06-18, stdio transport support

### REQ-002: reqwest 0.13
- **ID**: REQ-002
- **Description**: Upgrade reqwest from 0.12 to 0.13
- **Rationale**: hyper 1.x, rustls 0.23, security fixes

### REQ-003: candle 0.11
- **ID**: REQ-003
- **Description**: Upgrade candle stack from 0.10 to 0.11
- **Rationale**: New tokenizer API, CUDA 12+ support

### REQ-004: tantivy 0.27
- **ID**: REQ-004
- **Description**: Upgrade tantivy from 0.26 to 0.27
- **Rationale**: New segment API, faster indexing

### REQ-005: keyring 4
- **ID**: REQ-005
- **Description**: Upgrade keyring from 3 to 4
- **Rationale**: New Entry API, Windows WebAuthn support

### REQ-006: Remove hf-hub
- **ID**: REQ-006
- **Description**: Remove hf-hub dependency
- **Rationale**: Manual model download via fetch-model.sh (ADR-0049)

### REQ-007: Remove axum
- **ID**: REQ-007
- **Description**: Remove axum dependency
- **Rationale**: HTTP transport removed (ADR-0047)

### REQ-008: Remove http, futures-core
- **ID**: REQ-008
- **Description**: Remove http and futures-core
- **Rationale**: Re-exported by rmcp/tokio, unused directly

### REQ-009: Add libc
- **ID**: REQ-009
- **Description**: Add libc 0.2 as cfg(unix) dependency
- **Rationale**: Platform-correct O_NOFOLLOW constant

## Acceptance Criteria

- [ ] `cargo check` passes with all new versions
- [ ] `cargo test` passes
- [ ] No unused dependency warnings
- [ ] libc only compiled on unix targets