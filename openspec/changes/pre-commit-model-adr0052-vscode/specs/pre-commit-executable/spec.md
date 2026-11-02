# Specification: Pre-commit Hook Executable Fix

## Scope

Git hook executable permission fix.

## Requirements

### REQ-401: Executable Bit

- **ID**: REQ-401
- **Description**: `.githooks/pre-commit` has executable bit set (mode 100755)
- **Rationale**: Git only executes hooks with +x permission

### REQ-402: Hook Execution

- **ID**: REQ-402
- **Description**: `git commit` triggers pre-commit hook after `git config core.hooksPath .githooks`
- **Rationale**: Validation runs on every commit

## Acceptance Criteria

- [ ] `ls -la .githooks/pre-commit` shows `-rwxr-xr-x`
- [ ] `git config core.hooksPath .githooks`
- [ ] `git commit` with formatting error → rejected with cargo fmt output
- [ ] `git commit` with clippy warning → rejected with clippy output
- [ ] `git commit` with doc warning → rejected with cargo doc output
