# Hooks: Add Copilot Hooks Infrastructure

Adds pre-commit validation, VS Code workspace settings, and GitHub Copilot hook configuration to enforce code quality and enable automated reviews.

## Files Added

- `.githooks/pre-commit` — POSIX shell hook running fmt, clippy, doc, gitleaks
- `.github/hooks/pali.json` — Machine-readable hook configuration schema
- `.vscode/settings.json` — Editor settings for rust-analyzer, format-on-save, testing

## Files Modified

- `CONTRIBUTING.md` — Hook activation instructions
- `README.md` — Hook setup steps

## Activation

```bash
git config core.hooksPath .githooks
```

## Validation

Each commit runs:
1. `cargo fmt -- --check` — style check
2. `cargo clippy -- -D warnings` — lint check
3. `cargo doc --no-deps` — documentation build
4. `gitleaks protect --staged` — secret scan (if gitleaks installed)