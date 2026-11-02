# Design

## Context

The extension's `activate` previously registered two commands and, on first
activation, opened `vscode:mcp/install?<JSON>` so the user could paste the
server config into VS Code's MCP settings. That indirection is fragile: the JSON
shape is undocumented, the link can be blocked, and the server only exists if
the user completes the step.

VS Code 1.101 introduced `vscode.lm.registerMcpServerDefinitionProvider`, which
lets an extension contribute an `McpStdioServerDefinition` directly. The editor
asks the provider for definitions and launches the process itself, so no user
action and no `vscode:mcp/install` link are involved.

For `O_NOFOLLOW`, `std::os::unix::fs::OpenOptionsExt::custom_flags` takes a raw
`i32`. The project previously hard-coded `0x20000` (Linux). macOS/BSD use
`0x0100`, so on those platforms the flag was wrong and the open silently followed
symlinks — defeating the symlink-rejection probe in `repo.rs`.

## Goals / Non-Goals

**Goals:**
- Enabling the extension registers the `pali` MCP server with no user action.
- `O_NOFOLLOW` is correct on every supported Unix kernel family.
- `native-certs` is gone and nothing references it.
- All docs and tests describe the new flow.

**Non-Goals:**
- No new settings, no new commands, no new configuration surface.
- No change to the MCP server binary itself or its wire protocol.
- No support for non-Unix platforms beyond leaving them untouched.

## Decisions

1. **Provider over install link.** Use
   `vscode.lm.registerMcpServerDefinitionProvider("pali", { ... })` returning an
   `McpStdioServerDefinition`. The provider is wrapped in a feature check
   (`typeof vscode.lm?.registerMcpServerDefinitionProvider === "function"`) so
   older VS Code builds log a warning instead of crashing.
2. **Data-only helper.** `lib.js` exports `mcpServerDefinition(config)` returning
   a plain object `{ label, command, args, env }`; `activate` wraps it in
   `vscode.McpStdioServerDefinition`. This keeps the shape testable without the
   extension host, matching the existing `buildHookConfig` pattern.
3. **`libc` for `O_NOFOLLOW`.** Rather than a per-platform `cfg` constant, use
   `libc::O_NOFOLLOW` so the value always matches the running kernel. Document
   the pitfall in the module doc comment.
4. **Drop `native-certs` outright.** It gated nothing; removing the `[features]`
   block is a clean deletion. Update `AGENTS.md`'s semver-check sentence, which
   referenced it by name.

## Risks / Trade-offs

- The provider API is VS Code 1.101+; users on older builds get no server
  registration and must configure the client manually (documented in the
  output channel message).
- Removing `native-certs` is a breaking change for anyone invoking
  `--features native-certs`; recorded in the CHANGELOG as a behavior change.
- `libc` adds a dependency, but only on Unix and only for one constant.