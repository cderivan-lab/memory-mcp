# Detailed Design: Hooks Copilot Infrastructure

## Change: hooks-copilot-hooks-infrastructure

### Purpose

Add pre-commit validation, copilot hooks for automated review, and standardized hook configuration to enforce code quality and enable automated agent-assisted reviews.

### New Capabilities

#### `pre-commit-hooks`

- `.githooks/pre-commit`: Runs `cargo fmt`, `cargo clippy`, `cargo doc`, and `gitleaks` (when installed) on every commit
- Made executable with +x bit

#### `copilot-hook-config`

- `.github/hooks/pali.json`: JSON schema for hook configuration including commands, file patterns, and tool availability
- VS Code settings (`.vscode/settings.json`): Editor settings for rust-analyzer, format on save, clippy hints, and test explorer

#### `vscode-workspace-settings`

- Standardized editor configuration contributed through `.vscode/settings.json`

### Design Decisions

#### 1. Pre-Commit Hook

```bash
#!/bin/bash
set -e

# Run cargo fmt check
cargo fmt -- --check

# Run cargo clippy
cargo clippy -- -D warnings

# Run cargo doc
cargo doc --no-deps

# Run gitleaks if installed
if command -v gitleaks &> /dev/null; then
    gitleaks protect --staged
fi
```

- Runs on every commit
- Validates style, lint, docs, and secret leaks
- No breaking changes to build or runtime

#### 2. Hook Configuration (.github/hooks/pali.json)

```json
{
  "preCommit": {
    "enabled": true,
    "commands": ["cargo fmt", "cargo clippy", "cargo doc"],
    "toolAvailability": ["cargo", "gitleaks"]
  },
  "copilotHooks": {
    "enabled": true,
    "events": ["sessionStart", "userPromptTransformed", "agentStop"],
    "timeoutMs": 30000
  }
}
```

- JSON schema for hook configuration
- Extension writes `~/.copilot/hooks/pali.json` at activation
- Idempotent: left untouched when content is already current
- Warning on write failure, doesn't block activation

#### 3. VS Code Settings (.vscode/settings.json)

```json
{
  "rust-analyzer.formatOnSave": true,
  "rust-analyzer.clipboardCopyToClipboard": true,
  "editor.codeActionsOnSave": {
    "source.rust-analyzer.fixAll": true
  },
  "rust-analyzer.all.sortImports": true,
  "rust-analyzer.hint.enable": true,
  "testExplorer.testDefaultTimeout": 60000
}
```

- Consistent formatting and linting from first open
- Configures rust-analyzer and test explorer

#### 4. Contribution Workflow (CONTRIBUTING.md)

- Hook setup instructions included
- New contributors guided through hook activation
- Workflow aligns with pre-commit validation

### Impact

- All commits now validated for style, lint, docs, and secret leaks
- VS Code users get consistent formatting and linting from first open
- Contributors guided through hook activation in CONTRIBUTING.md
- No breaking changes to build or runtime
