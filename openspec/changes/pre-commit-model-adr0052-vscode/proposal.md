# Proposal

## Why

Several remaining items from the reorganization needed completion:

1. Pre-commit hook was missing executable bit (+x), so it never ran
2. BGE-small-en-v1.5 embedding model needed local provisioning for offline operation
3. ADR-0052 documented optional in-memory HTTPS token storage
4. VS Code extension needed MCP provider registration updates
5. OpenSpec change needed for vscode extension MCP provider

## What Changes

### Fixed

- **.githooks/pre-commit**: Added executable bit (mode 100755)

### Added

- **models/bge-small-en-v1.5/**: Small model metadata committed to git
  - `config.json` — Model configuration
  - `tokenizer.json` — Tokenizer vocabulary
- **`.gitignore`** entry for `models/bge-small-en-v1.5/model.safetensors` — the ~130MB
  weights are never committed; they are provisioned locally via
  `scripts/fetch-model.sh` or the VS Code extension (ADR-0049)

- **docs/adr/0052-optional-in-memory-https-token.md**: ADR for optional HTTPS token storage in memory

- **.github/hooks/pali.json**: Hook configuration schema

- **.vscode/settings.json**: Workspace editor settings

- **openspec/changes/vscode-extension-mcp-provider-and-o-nofollow/**: OpenSpec change for VS Code extension MCP provider registration

### Modified

- **src/embedding/candle.rs**: Updated for local model loading from `PALI_MODEL_DIR`
- **vscode-extension/**: Full extension rewrite for MCP provider registration
  - `extension.js` — MCP server definition provider
  - `lib.js` — Exports `mcpServerDefinition`
  - `package.json` — `mcpServerDefinitionProviders` contribution
  - `test/` — Integration tests
  - `CHANGELOG.md`, `README.md` — Updated docs

## Capabilities

### New Capabilities

- `bge-model-provisioning`: BGE-small-en-v1.5 provisioned locally for offline embedding (weights not committed)
- `adr-0052`: Optional in-memory HTTPS token storage design
- `vscode-mcp-provider`: Extension registers pali via VS Code MCP API
- `hook-config-schema`: Machine-readable hook configuration

### Modified Capabilities

- `pre-commit-hooks`: Now actually executable and enforced
- `embedding-model-loading`: Loads from `PALI_MODEL_DIR` or the local model dir
- `vscode-extension`: Uses MCP server definition provider (VS Code 1.101+)

## Impact

- Pre-commit now runs on every commit (fmt, clippy, doc, gitleaks)
- Model works offline once provisioned locally (no HF Hub download at runtime);
  the ~130MB weights stay out of git (ADR-0049)
- ADR-0052 provides design for future HTTPS token caching
- VS Code extension auto-registers MCP server on activation
- OpenSpec change tracks vscode extension MCP provider work
