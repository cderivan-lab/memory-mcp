# Proposal

## Why

The project had no pre-commit validation, no copilot hooks for automated review, and no standardized hook configuration. This commit adds the full hook infrastructure to enforce code quality and enable automated agent-assisted reviews.

## What Changes

- **Pre-commit hook** (`.githooks/pre-commit`): Runs `cargo fmt`, `cargo clippy`, `cargo doc`, and `gitleaks` (when installed) on every commit. Made executable.
- **Hook configuration** (`.github/hooks/pali.json`): JSON schema for hook configuration including commands, file patterns, and tool availability.
- **VS Code settings** (`.vscode/settings.json`): Editor settings for rust-analyzer, format on save, clippy hints, and test explorer.
- **CONTRIBUTING.md**: Added hook setup instructions and contribution workflow.
- **README.md**: Updated with hook activation steps.

## Capabilities

### New Capabilities
- `pre-commit-hooks`: Cargo fmt, clippy, doc checks + secret scanning on every commit
- `copilot-hook-config`: GitHub Copilot hook configuration schema
- `vscode-workspace-settings`: Standardized editor configuration

### Modified Capabilities
- (none)

## Impact

- All commits now validated for style, lint, docs, and secret leaks
- VS Code users get consistent formatting and linting from first open
- Contributors guided through hook activation in CONTRIBUTING.md
- No breaking changes to build or runtime