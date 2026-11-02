# Pre-comfix Hook, BGE Model, ADR-0052, VS Code Extension

Completes remaining reorganization items: executable hook, locally-provisioned model, ADR, vscode extension MCP provider.

## Files Fixed

- `.githooks/pre-commit` — Added executable bit (100755)

## Files Added

- `models/bge-small-en-v1.5/` — Embedding model metadata
  - `config.json`, `tokenizer.json` (committed); `model.safetensors` is gitignored and fetched via `scripts/fetch-model.sh` (ADR-0049)
- `docs/adr/0052-optional-in-memory-https-token.md` — ADR for token caching
- `.github/hooks/pali.json` — Hook configuration schema
- `.vscode/settings.json` — Workspace editor settings
- `openspec/changes/vscode-extension-mcp-provider-and-o-nofollow/` — OpenSpec change

## Files Modified

- `src/embedding/candle.rs` — Load model from `PALI_MODEL_DIR`
- `vscode-extension/` — Full rewrite for MCP provider
  - `extension.js`, `lib.js`, `package.json`
  - `test/extension.test.js`, `test/vsix.test.js`
  - `CHANGELOG.md`, `README.md`

## Key Changes

### Pre-commit Hook

```bash
git config core.hooksPath .githooks  # Now works (was missing +x)
```

### BGE Model

```bash
export PALI_MODEL_DIR=/path/to/models/bge-small-en-v1.5
# Or place in ./models/bge-small-en-v1.5/
```

### ADR-0052

Optional in-memory token cache:

```bash
PALI_TOKEN_CACHE=memory pali serve  # Enable memory cache
```

### VS Code Extension

- Registers `pali` MCP server via `vscode.lm.registerMcpServerDefinitionProvider`
- Uses `McpStdioServerDefinition` from `pali.*` settings
- Requires VS Code 1.101+
- No more manual `vscode:mcp/install` link
