# Specification: Stdio-Only Transport

## ADDED Requirements

### Requirement: REQ-201 Remove HTTP Transport

- **ID**: REQ-201
- **Description**: Remove all axum-based HTTP server code
- **Rationale**: ADR-0047 mandates stdio-only

#### Scenario: HTTP transport removal

- **WHEN** axum-based HTTP server code is removed
- **THEN** all HTTP handlers and listeners are eliminated

### Requirement: REQ-202 Remove SSE Transport

- **ID**: REQ-202
- **Description**: Remove Server-Sent Events handler
- **Rationale**: Part of HTTP transport stack

#### Scenario: SSE transport removal

- **WHEN** the SSE handler is removed
- **THEN** it is no part of the transport layer

### Requirement: REQ-203 Remove k8s Feature

- **ID**: REQ-203
- **Description**: Remove `k8s` cargo feature and conditional compilation
- **Rationale**: HTTP-dependent Kubernetes deployment

#### Scenario: k8s feature removal

- **WHEN** the k8s cargo feature is removed
- **THEN** all `#[cfg(feature = "k8s")]` conditional compilation is eliminated

### Requirement: REQ-204 Simplify CLI

- **ID**: REQ-204
- **Description**: Remove `--http`, `--port`, `--host` arguments
- **Rationale**: No HTTP server to configure

#### Scenario: CLI simplification

- **WHEN** `--http`, `--port`, `--host` arguments are removed
- **THEN** the CLI no longer accepts these flags

### Requirement: REQ-205 Simplify Docker

- **ID**: REQ-205
- **Description**: Remove EXPOSE 8080, HF_HOME, k8s feature from Dockerfile
- **Rationale**: No HTTP server in container

#### Scenario: Docker simplification

- **WHEN** the Dockerfile is updated
- **THEN** EXPOSE 8080, HF_HOME, and k8s features are removed

### Requirement: REQ-206 Retain Passive Health

- **ID**: REQ-206
- **Description**: Keep `SubsystemReporter` for structured health logging
- **Rationale**: ADR-0006 requires observability without HTTP

#### Scenario: Passive health retention

- **WHEN** health logging is reviewed
- **THEN** `SubsystemReporter` is kept for structured logging

### Requirement: REQ-207 Retain Stdio Transport

- **ID**: REQ-207
- **Description**: `serve_stdio()` using rmcp stdio transport remains
- **Rationale**: Primary and only MCP transport

#### Scenario: Stdio transport retention

- **WHEN** the transport is verified
- **THEN** `serve_stdio()` using rmcp stdio transport is the only transport
