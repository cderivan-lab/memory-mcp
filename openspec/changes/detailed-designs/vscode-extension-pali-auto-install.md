# Detailed Design: VS Code Pali Auto-Install

## Change: vscode-extension-pali-auto-install

### Purpose

The VS Code extension should detect the missing pali binary and offer to download and install it automatically, making the extension self-contained for new users.

### New Capability: `vscode-extension-pali-auto-install`

#### Binary Detection Logic

- Check configured `binPath` first
- Fall back to PATH lookup
- Check cached download location
- If binary not found, trigger download flow

#### Download Flow

- **Source**: Prebuilt binary from release server (Gitea/GitHub)
- **Matching**: Host architecture (darwin/linux, x86_64/arm64)
- **Naming**: Predictable naming (`pali-{target}`)
- **Progress**: Reported during download via VS Code `withProgress`

#### Installation

- **Location**: Extension's `globalStorage` (persistent, per-user, no permission issues)
- **Path**: Saved to `globalStorage` with key `pali_binary_path`
- **Settings update**: Automatically set `pali.binPath` to the downloaded binary path

#### Server Restart

- Fire `serverChanged` event to re-register MCP server definition
- Ensures MCP server is available after installation

#### UX Design

- **Modal notification** on extension activation when pali binary is missing
- **Options**:
  - "Download Now" — triggers download and restarts server
  - "Open Settings" — opens extension settings
  - "Later" — dismisses for now
- **Progress reporting**: During download via `window.withProgress`
- **Fallback**: If download fails, show error with manual install instructions

### Implementation Design

#### Files Touched

- `vscode-extension/extension.js`: Detection, download, notification, progress
- `vscode-extension/lib.js`: Binary resolution logic, download orchestration
- `vscode-extension/package.json`: Potential new dependency for HTTP client

#### Dependencies

- Node.js `https`/`fetch` for release server API calls
- VS Code `globalStorage` for persistent binary path storage
- `window.showInformationMessage` for modal notification
- `window.withProgress` for progress reporting
- `workspace.getConfiguration().update()` for settings updates

#### Settings Integration

- Auto-updates `pali.binPath` setting on successful download
- Ensures MCP server re-registration via `serverChanged` event
- Persists across extension restarts via `globalStorage`

### Impact

- **Self-contained experience**: New users don't need separately install pali CLI
- **First-run UX**: Modal offers immediate download option
- **Persistence**: Downloaded binary stored in `globalStorage`, survives extension restarts
- **Fallback**: If download fails, user gets manual install instructions
- **No breaking changes**: Existing users with pali on PATH unaffected
