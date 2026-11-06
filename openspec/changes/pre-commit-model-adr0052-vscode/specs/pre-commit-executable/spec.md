# Specification: Pre-commit Hook Executable Fix

## ADDED Requirements

### Requirement: REQ-401 Executable Bit

- **ID**: REQ-401
- **Description**: `.githooks/pre-commit` has executable bit set (mode 100755)
- **Rationale**: Git only executes hooks with +x permission

#### Scenario: Executable bit check

- **WHEN** the executable bit is checked
- **THEN** it is set to mode 100755

### Requirement: REQ-402 Hook Execution

- **ID**: REQ-402
- **Description**: `git commit` triggers pre-commit hook after `git config core.hooksPath .githooks`
- **Rationale**: Validation runs on every commit

#### Scenario: Hook execution

- **WHEN** `git commit` is run
- **THEN** the pre-commit hook is triggered
