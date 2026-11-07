# Specification: Pre-commit Hooks

## ADDED Requirements

### Requirement: REQ-001 Style Validation

- **ID**: REQ-001
- **Description**: `cargo fmt -- --check` must pass on staged files
- **Rationale**: Consistent formatting across contributors

#### Scenario: Formatting check

- **WHEN** `cargo fmt -- --check` is run on staged files
- **THEN** it passes without modifying files

### Requirement: REQ-002 Lint Validation

- **ID**: REQ-002
- **Description**: `cargo clippy -- -D warnings` must pass on workspace
- **Rationale**: Catch common mistakes and enforce idiomatic Rust

#### Scenario: Clippy lint check

- **WHEN** `cargo clippy -- -D warnings` is run on the workspace
- **THEN** it passes without warnings

### Requirement: REQ-003 Documentation Build

- **ID**: REQ-003
- **Description**: `cargo doc --no-deps` must succeed without warnings
- **Rationale**: Public API docs always buildable

#### Scenario: Doc build check

- **WHEN** `cargo doc --no-deps` is run
- **THEN** it succeeds without warnings

### Requirement: REQ-004 Secret Scanning

- **ID**: REQ-004
- **Description**: `gitleaks protect --staged` scans staged content when gitleaks available
- **Rationale**: Prevent credential leaks

#### Scenario: Gitleaks scanning

- **WHEN** `gitleaks protect --staged` is run on staged content
- **THEN** it scans for secrets when gitleaks is installed

### Requirement: REQ-005 Hook Activation

- **ID**: REQ-005
- **Description**: `git config core.hooksPath .githooks` activates hooks
- **Rationale**: Single-command setup documented in CONTRIBUTING

#### Scenario: Hook activation

- **WHEN** `git config core.hooksPath .githooks` is set
- **THEN** hooks are activated for the repository

### Requirement: REQ-006 VS Code Integration

- **ID**: REQ-006
- **Description**: `.vscode/settings.json` configures rust-analyzer, format-on-save, clippy
- **Rationale**: Real-time feedback without waiting for commit

#### Scenario: VS Code settings

- **WHEN** the workspace is opened in VS Code
- **THEN** rust-analyzer shows clippy hints and format-on-save works

### Requirement: REQ-007 Hook Schema

- **ID**: REQ-007
- **Description**: `.github/hooks/pali.json` defines machine-readable hook configuration
- **Rationale**: Enables tooling to validate/extend hooks

#### Scenario: Hook schema definition

- **WHEN** `.github/hooks/pali.json` is reviewed
- **THEN** it defines the machine-readable hook configuration
