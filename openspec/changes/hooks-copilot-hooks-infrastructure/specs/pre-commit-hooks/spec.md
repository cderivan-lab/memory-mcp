# Specification: Pre-commit Hooks

## Scope

Git pre-commit validation pipeline and IDE integration settings.

## Requirements

### REQ-001: Style Validation
- **ID**: REQ-001
- **Description**: `cargo fmt -- --check` must pass on staged files
- **Rationale**: Consistent formatting across contributors

### REQ-002: Lint Validation
- **ID**: REQ-002
- **Description**: `cargo clippy -- -D warnings` must pass on workspace
- **Rationale**: Catch common mistakes and enforce idiomatic Rust

### REQ-003: Documentation Build
- **ID**: REQ-003
- **Description**: `cargo doc --no-deps` must succeed without warnings
- **Rationale**: Public API docs always buildable

### REQ-004: Secret Scanning
- **ID**: REQ-004
- **Description**: `gitleaks protect --staged` scans staged content when gitleaks available
- **Rationale**: Prevent credential leaks

### REQ-005: Hook Activation
- **ID**: REQ-005
- **Description**: `git config core.hooksPath .githooks` activates hooks
- **Rationale**: Single-command setup documented in CONTRIBUTING

### REQ-006: VS Code Integration
- **ID**: REQ-006
- **Description**: `.vscode/settings.json` configures rust-analyzer, format-on-save, clippy
- **Rationale**: Real-time feedback without waiting for commit

### REQ-007: Hook Schema
- **ID**: REQ-007
- **Description**: `.github/hooks/pali.json` defines machine-readable hook configuration
- **Rationale**: Enables tooling to validate/extend hooks

## Acceptance Criteria

- [ ] Fresh clone + `git config core.hooksPath .githooks` → commit rejected on fmt failure
- [ ] Fresh clone + hook activated → commit rejected on clippy warning
- [ ] Fresh clone + hook activated → commit rejected on doc warning
- [ ] gitleaks installed + hook activated → commit rejected on secret in staged file
- [ ] VS Code opens workspace → rust-analyzer shows clippy hints, format-on-save works