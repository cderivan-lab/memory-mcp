# Specification: Dependency Upgrades

## ADDED Requirements

### Requirement: REQ-001 rmcp 3.8

- **ID**: REQ-001
- **Description**: Upgrade rmcp from 1.1 to 3.8
- **Rationale**: MCP protocol 2025-06-18, stdio transport support

#### Scenario: MCP protocol upgrade

- **WHEN** the rmcp version is upgraded
- **THEN** MCP protocol 2025-06-18 features are available

### Requirement: REQ-003 candle 0.11

- **ID**: REQ-003
- **Description**: Upgrade candle stack from 0.10 to 0.11
- **Rationale**: New tokenizer API, CUDA 12+ support

#### Scenario: Candle tokenizer API

- **WHEN** the candle version is upgraded
- **THEN** the new tokenizer API is available

### Requirement: REQ-004 tantivy 0.27

- **ID**: REQ-004
- **Description**: Upgrade tantivy from 0.26 to 0.27
- **Rationale**: New segment API, faster indexing

#### Scenario: Tantivy segment API

- **WHEN** the tantivy version is upgraded
- **THEN** the new segment API is available

### Requirement: REQ-005 keyring 4

- **ID**: REQ-005
- **Description**: Upgrade keyring from 3 to 4
- **Rationale**: New Entry API, Windows WebAuthn support

#### Scenario: Keyring entry API

- **WHEN** the keyring version is upgraded
- **THEN** the new entry API is available

### Requirement: REQ-009 libc 0.2

- **ID**: REQ-009
- **Description**: Add libc 0.2 as cfg(unix) dependency
- **Rationale**: Platform-correct O_NOFOLLOW constant

#### Scenario: libc O_NOFOLLOW

- **WHEN** running on unix targets
- **THEN** O_NOFOLLOW constant is available

## REMOVED Requirements

### Requirement: REQ-006 Remove hf-hub

- **ID**: REQ-006
- **Description**: Remove hf-hub dependency
- **Rationale**: Manual model download via fetch-model.sh (ADR-0049)

#### Scenario: hf-hub removal

- **WHEN** hf-hub is removed
- **THEN** model download is handled via fetch-model.sh

### Requirement: REQ-007 Remove axum

- **ID**: REQ-007
- **Description**: Remove axum dependency
- **Rationale**: HTTP transport removed (ADR-0047)

#### Scenario: axum removal

- **WHEN** axum is removed
- **THEN** HTTP transport is handled differently

### Requirement: REQ-008 Remove http, futures-core

- **ID**: REQ-008
- **Description**: Remove http and futures-core
- **Rationale**: Re-exported by rmcp/tokio, unused directly

#### Scenario: http and futures-core removal

- **WHEN** http and futures-core are removed
- **THEN** they are re-exported by rmcp/tokio and not used directly
