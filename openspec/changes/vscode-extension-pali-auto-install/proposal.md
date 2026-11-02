# Proposal

## Why

The VS Code extension currently relies on users having `pali` installed and available on their PATH. If the binary is missing, the MCP server fails silently with no actionable guidance. This creates a poor first-run experience — users install the extension, see nothing happen, and don't know they need to separately install a CLI tool. The extension should detect the missing binary and offer to download and install it automatically, making the extension self-contained for new users.

## What Changes

- **New capability**: `vscode-extension-pali-auto-install` — detects missing pali binary at startup, offers to download/install it from releases, updates settings, and restarts the MCP server
- **Binary detection**: Check configured `binPath` → PATH → cached download location
- **Download flow**: Fetch prebuilt binary from release server (Gitea/GitHub) matching host architecture
- **Installation**: Save to extension's `globalStorage` (persistent, per-user, no permission issues)
- **Settings update**: Automatically set `pali.binPath` to the downloaded binary path
- **Server restart**: Fire `serverChanged` event to re-register MCP server definition
- **UX**: Modal notification with "Download Now" / "Open Settings" / "Later" options, progress reporting during download

## Capabilities

### New Capabilities

- `vscode-extension-pali-auto-install`: Self-installing pali binary for VS Code extension — detects missing pali binary, downloads prebuilt release matching host architecture, installs to globalStorage, updates binPath setting, restarts MCP server

### Modified Capabilities

- (none — this is a new UX capability layered on top of existing MCP provider registration)

## Impact

- **Files touched**: `vscode-extension/extension.js` (detection, download, notification), `vscode-extension/lib.js` (binary resolution logic), `vscode-extension/package.json` (potential new dependency for HTTP client)
- **Dependencies**: Node.js `https`/`fetch`, VS Code `globalStorage`, `window.showInformationMessage`, `window.withProgress`, `workspace.getConfiguration().update()`
- **External**: Release server must serve prebuilt binaries with predictable naming (`pali-{target}`); CI already publishes Linux/macOS universals
- **Settings**: `pali.binPath` auto-updated on successful download
- **Fallback**: If download fails, show error with manual install instructions
