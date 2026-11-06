# Detailed Design: VS Code MCP Provider and O_NOFOLLOW Fix

## Change: vscode-extension-mcp-provider-and-o-nofollow

### Purpose

Replace the manual MCP server registration flow with VS Code's MCP server definition provider API, remove the dead `native-certs` cargo feature, and fix platform-correct `O_NOFOLLOW` constant.

### New Capability: `vscode-extension-mcp-registration`

#### 1. MCP Server Registration via Provider API

- **Replace**: `vscode:mcp/install` link and `Pali: Install MCP Server` command
- **With**: `vscode.lm.registerMcpServerDefinitionProvider("pali")` call in `activate`
- **Provider emits**: `McpStdioServerDefinition` objects built from `pali.*` settings
- **`lib.js` exports**: `mcpServerDefinition` (plain data object) instead of `mcpInstallUrl`
- **`package.json`**: Contributes `mcpServerDefinitionProviders` point instead of two commands
- **Tests**: Updated to follow new pattern

#### 2. Remove `native-certs` Cargo Feature

- Delete the `[features]` block mentioning `native-certs` from `pali/Cargo.toml`
- Remove `--features native-certs` mention from `AGENTS.md`
- The feature is dead weight: ADR-0049 removed automatic model download, so it no longer resolves

#### 3. Platform-Correct `O_NOFOLLOW`

- **Add** `pub(crate) const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;` behind `#[cfg(unix)]` in `src/fs_util.rs`
- **Add** `libc = "0.2"` as `cfg(unix)` dependency
- **Replace** two hard-coded `0x20000` call sites in `src/fs_util.rs` and `src/repo.rs` with `crate::fs_util::O_NOFOLLOW`
- **macOS/BSD**: The flag is `0x0100` (was silently `0x20000` which degrades to "follow the link")

#### 4. rustdoc Cleanup

- Convert intra-doc links `[`model_dir`]` / `[`load_model_files`]` to plain code spans in `src/embedding/candle.rs`

#### 5. Documentation Updates

- `README.md`, `docs/clients.md`, `docs/getting-started.md`, `vscode-extension/README.md`
- Describe the new registration flow and the removed feature

### Design Decisions

#### MCP Provider API Requirements

- VS Code 1.101+ required for the new provider API
- Older builds log that the API is absent and fall back to no server registration
- Users who ran `Pali: Install MCP Server` before will find the command gone; server is now registered automatically

#### O_NOFOLLOW Platform Differences

- Linux: `O_NOFOLLOW = 0x20000`
- macOS/BSD: `O_NOFOLLOW = 0x0100`
- The constant must be platform-aware to correctly reject symlinks

#### Feature Removal Impact

- `--features native-certs` no longer resolves
- Any CI or local invocation using it must drop the flag
- No functionality loss — the feature was already dead per ADR-0049

### Impact

- VS Code 1.101+ required for new provider API; older builds log and fall back
- Users find `Pali: Install MCP Server` command gone; server registered automatically
- `--features native-certs` no longer resolves; CI/local invocations must drop it
- `libc` crate added behind `cfg(unix)` only; non-unix builds unchanged
- Symlink-rejection on macOS/BSD now matches Linux instead of silently following
- rustdoc links cleaned up in candle embedding module
