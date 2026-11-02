# Proposal

## Why

The VS Code extension currently asks users to open a `vscode:mcp/install` link and
run a command-palette action to register the `pali` MCP server. That flow is
manual, easy to miss, and leaves the server unregistered until the user happens to
run it. VS Code 1.101+ ships an MCP server definition provider API that lets an
extension hand the server definition straight to the editor, so enabling the
extension is enough.

Separately, the empty `native-certs` cargo feature is dead weight: ADR-0049
removed automatic model download, so `--features native-certs` no longer resolves
and nothing references it. Finally, the hard-coded `O_NOFOLLOW` value `0x20000`
is Linux-only; on macOS/BSD the flag is `0x0100`, so the constant silently
degrades to "follow the symlink" instead of rejecting symlinks.

## What Changes

- **VS Code extension.** Replace the `vscode:mcp/install` link and the
  `Pali: Install MCP Server` / `Pali: Install Copilot Hooks` commands with a
  `vscode.lm.registerMcpServerDefinitionProvider("pali")` call in `activate`.
  The provider emits `McpStdioServerDefinition` objects built from the
  `pali.*` settings. `lib.js` exports `mcpServerDefinition` (a plain data
  object) instead of `mcpInstallUrl`; `package.json` contributes an
  `mcpServerDefinitionProviders` point instead of two commands; tests follow.
- **Remove `native-certs` cargo feature.** Delete the `[features]` block and the
  `--features native-certs` mention in `AGENTS.md`.
- **Platform-correct `O_NOFOLLOW`.** Add `pub(crate) const O_NOFOLLOW: i32 =
  libc::O_NOFOLLOW;` (behind `#[cfg(unix)]`) in `src/fs_util.rs`, add
  `libc = "0.2"` as a `cfg(unix)` dependency, and replace the two hard-coded
  `0x20000` call sites in `src/fs_util.rs` and `src/repo.rs` with
  `crate::fs_util::O_NOFOLLOW`.
- **rustdoc cleanup.** Convert intra-doc links `[`model_dir`]` / `[`load_model_files`]`
  to plain code spans in `src/embedding/candle.rs`.
- **Docs.** Update `README.md`, `docs/clients.md`, `docs/getting-started.md`,
  and `vscode-extension/README.md` to describe the new registration flow and the
  removed feature.

## Capabilities

### New Capabilities
- `vscode-extension-mcp-registration`: the extension registers the `pali` MCP
  server through VS Code's MCP server definition provider on activation.
- `cargo-features`: the cargo feature surface for `pali`, including the removal
  of the empty `native-certs` feature.

### Modified Capabilities
- (none — the `native-certs` removal and the `O_NOFOLLOW` fix are internal
  cleanup captured in tasks.md and the CHANGELOG, not spec-level behavior)

## Impact

- VS Code 1.101+ required for the new provider API; older builds log that the
  API is absent and fall back to no server registration.
- Users who ran `Pali: Install MCP Server` before will find the command gone;
  the server is now registered automatically.
- `--features native-certs` no longer resolves; any CI or local invocation using
  it must drop the flag.
- The `libc` crate is added behind `cfg(unix)` only; non-unix builds are
  unchanged.
- Symlink-rejection behavior on macOS/BSD now matches Linux instead of silently
  following the link.