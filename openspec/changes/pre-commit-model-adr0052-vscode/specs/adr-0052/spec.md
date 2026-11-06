# Specification: ADR-0052 Optional In-Memory HTTPS Token Storage

## ADDED Requirements

### Requirement: REQ-421 ADR Document

- **ID**: REQ-421
- **Description**: `docs/adr/0052-optional-in-memory-https-token.md` exists with standard ADR format
- **Rationale**: Architectural decision recorded

#### Scenario: ADR document existence

- **WHEN** the ADR document is checked for existence
- **THEN** it exists with standard ADR format

### Requirement: REQ-422 Decision Recorded

- **ID**: REQ-422
- **Description**: ADR documents context, decision, consequences for in-memory token cache
- **Rationale**: Future reference for implementation

#### Scenario: Decision recorded

- **WHEN** the ADR decision is reviewed
- **THEN** context, decision, consequences are documented

### Requirement: REQ-423 Optional Feature

- **ID**: REQ-423
- **Description**: In-memory cache disabled by default, enabled via `PALI_TOKEN_CACHE=memory`
- **Rationale**: Opt-in for environments without keyring

#### Scenario: Optional feature flag

- **WHEN** `PALI_TOKEN_CACHE=memory` is set
- **THEN** in-memory cache is enabled

## ADR Structure

| Section | Content |
| --------- | --------- |
| Title | Optional In-Memory HTTPS Token Storage |
| Status | Accepted |
| Context | Keyring unavailable in CI/containers; need fallback |
| Decision | Add optional in-memory cache with TTL, behind env flag |
| Consequences | No persistence, thread-safe, zero deps when disabled |

## Acceptance Criteria

- [ ] `docs/adr/0052-optional-in-memory-https-token.md` exists
- [ ] Follows existing ADR format (numbered, status, sections)
- [ ] Documents context, decision, consequences
- [ ] References keyring as primary, memory as fallback
- [ ] Notes TTL, thread-safety, no persistence
