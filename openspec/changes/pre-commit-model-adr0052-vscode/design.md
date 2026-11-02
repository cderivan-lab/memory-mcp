# Design

## Pre-commit Hook Executable Bit

The hook script existed but lacked `+x` permission:

```text
# Before (broken)
-rw-r--r-- 1 user group 1234 .githooks/pre-commit

# After (fixed)
-rwxr-xr-x 1 user group 1234 .githooks/pre-commit
```

Git only executes hooks with executable bit set. Fixed via `git update-index --chmod=+x`.

## BGE Model Provisioning

```text
models/
└── bge-small-en-v1.5/
    ├── config.json        # committed (~1KB)
    ├── tokenizer.json     # committed, WordPiece vocab (~700KB)
    └── model.safetensors  # NOT committed (~130MB, gitignored)
```

- `config.json` and `tokenizer.json` are committed (small); `model.safetensors`
  is gitignored and provisioned via `scripts/fetch-model.sh` (ADR-0049) or the
  VS Code extension's model install — never committed to git
- Loaded from `PALI_MODEL_DIR` env var or `./models/bge-small-en-v1.5/`
- `src/embedding/candle.rs` uses `candle-transformers::bert::BertModel`

## ADR-0052: Optional In-Memory HTTPS Token Storage

**Context**: OAuth tokens for GitHub/remote access currently stored in keyring. Some environments (CI, containers) lack keyring access.

**Decision**: Add optional in-memory token cache with TTL, disabled by default. Enabled via `PALI_TOKEN_CACHE=memory`.

**Consequences**:

- No persistence across restarts
- Thread-safe with RwLock
- Zero dependencies when disabled
- Keyring remains primary storage

## VS Code Extension MCP Provider

**Architecture**:

```text

┌────────────────────────────────────┐
│       VS Code 1.101+               │
│  ┌──────────────────────────────┐  │
│  │  mcpServerDefinitionProvider │  │
│  │  (contribution point)        │  │
│  └──────────────┬───────────────┘  │
│                 │                  │
│  ┌──────────────▼───────────────┐  │
│  │  pali extension (activate)   │  │
│  │  vscode.lm.registerMcp       │  │
│  │  ServerDefinitionProvider    │  │
│  └──────────────┬───────────────┘  │
│                 │                  │
│  ┌──────────────▼───────────────┐  │
│  │  provideMcpServerDefinitions │  │
│  │  → McpStdioServerDefinition  │  │
│  └──────────────┬───────────────┘  │
└────────────────────────────────────┘
```

**Files**:

- `extension.js` — Entry point, registers provider
- `lib.js` — Exports `mcpServerDefinition` (plain object)
- `package.json` — Contributes `mcpServerDefinitionProviders`

**Settings used**:

- `pali.command` — CLI command (default: "pali")
- `pali.args` — Arguments (default: ["serve"])
- `pali.env` — Environment variables object

## Hook Configuration Schema

```json
// .github/hooks/pali.json
{
  "version": 1,
  "commands": [
    {
      "name": "fmt",
      "run": "cargo fmt -- --check",
      "stage": "pre-commit",
      "when": ["**/*.rs"]
    },
    {
      "name": "clippy",
      "run": "cargo clippy -- -D warnings",
      "stage": "pre-commit",
      "when": ["**/*.rs"]
    },
    {
      "name": "doc",
      "run": "cargo doc --no-deps",
      "stage": "pre-commit",
      "when": ["**/*.rs"]
    },
    {
      "name": "gitleaks",
      "run": "gitleaks protect --staged",
      "stage": "pre-commit",
      "when": ["**/*"],
      "optional": true
    }
  ],
  "tools": ["cargo", "gitleaks"],
  "failFast": true
}
```

## VS Code Settings

```json
// .vscode/settings.json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "rust-lang.rust-analyzer",
  "rust-analyzer.checkOnSave": "clippy",
  "rust-analyzer.cargo.features": "all",
  "testing.autoReveal": true,
  "files.exclude": {
    "**/target": true,
    "**/*.safetensors": true
  }
}
```
