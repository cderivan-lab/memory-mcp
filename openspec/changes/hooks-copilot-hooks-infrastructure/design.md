# Design

## Architecture

The hook system uses three layers:

1. **Git-level** (`.githooks/pre-commit`): POSIX shell script running cargo checks
2. **Configuration** (`.github/hooks/pali.json`): Machine-readable hook definitions
3. **Editor** (`.vscode/settings.json`): IDE integration for real-time feedback

## Components

### .githooks/pre-commit
```bash
#!/bin/sh
git config core.hooksPath .githooks
cargo fmt -- --check
cargo clippy -- -D warnings
cargo doc --no-deps
command -v gitleaks >/dev/null && gitleaks protect --staged
```

### .github/hooks/pali.json
Schema defines:
- `commands[]`: Each with `name`, `run`, `stage`, `when[]` (file globs)
- `tools[]`: Available tools (cargo, gitleaks, etc.)
- `failFast`: Stop on first failure

### .vscode/settings.json
- `editor.formatOnSave: true` with rustfmt
- `rust-analyzer.checkOnSave: "clippy"`
- `testing.autoReveal: true`

## Data Flow

1. Developer runs `git commit`
2. Git executes `.githooks/pre-commit`
3. Each cargo command runs in workspace root
4. On any failure, commit aborts with diagnostic output
5. gitleaks scans staged files for secrets (optional)

## Security

- gitleaks runs only on staged content
- No secrets passed to external services
- Hook itself tracked in repo (reviewable)