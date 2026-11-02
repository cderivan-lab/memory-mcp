# Tasks

- [x] Fix .githooks/pre-commit executable bit (+x)
- [x] Add models/bge-small-en-v1.5/ metadata (config.json, tokenizer.json); model.safetensors gitignored + fetched via fetch-model.sh (ADR-0049)
- [x] Create docs/adr/0052-optional-in-memory-https-token.md
- [x] Create .github/hooks/pali.json hook schema
- [x] Create .vscode/settings.json workspace settings
- [x] Update src/embedding/candle.rs for PALI_MODEL_DIR loading
- [x] Rewrite vscode-extension for MCP provider registration
  - [x] extension.js — register provider
  - [x] lib.js — mcpServerDefinition export
  - [x] package.json — mcpServerDefinitionProviders
  - [x] test/extension.test.js — integration tests
  - [x] test/vsix.test.js — packaging tests
  - [x] CHANGELOG.md, README.md — docs
- [x] Create openspec change for vscode-extension-mcp-provider-and-o-nofollow
- [x] Run cargo check
- [x] Run cargo test
- [x] Verify pre-commit hook executes
