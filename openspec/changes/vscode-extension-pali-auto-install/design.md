# Design

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐      ┌─────────────────┐      ┌───────────────┐  │
│  │   activate()    │─────▶│  resolveBinary  │─────▶│  MCP Provider │  │
│  │                 │      │                 │      │               │  │
│  │  - Check binPath│      │  - binPath?     │      │  Returns      │  │
│  │  - Check PATH   │      │  - PATH?        │      │  McpStdio     │  │
│  │  - Check cache  │      │  - globalStore? │      │  ServerDef    │  │
│  │                 │      │  - Missing?     │      │               │  │
│  └─────────────────┘      └────────┬────────┘      └───────────────┘  │
│                                    │                                  │
│                         ┌──────────┴──────────┐                       │
│                         ▼                     ▼                       │
│                ┌───────────────┐      ┌───────────────┐               │
│                │  Found        │      │  Missing      │               │
│                │  - Use it     │      │  - notify()   │               │
│                │  - Update     │      │  - Download   │               │
│                │    binPath    │      │  - Install    │               │
│                └───────────────┘      │  - Update     │               │
│                                       │    binPath    │               │
│                                       │  - Fire       │               │
│                                       │    server-    │               │
│                                       │    Changed    │               │
│                                       └───────────────┘               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────────┐
                    │   globalStorage       │
                    │   <globalStorage>/    │
                    │   pali (executable)   │
                    └───────────────────────┘
```

## Components

### 1. Binary Resolution (`lib.js`)

New function to centralize binary lookup logic:

```javascript
// lib.js additions
async function resolvePaliBinary(context, config) {
  // 1. Check configured binPath
  if (config.binPath && config.binPath !== 'pali') {
    const resolved = await resolvePath(config.binPath);
    if (resolved && await isExecutable(resolved)) {
      return { path: resolved, source: 'configured' };
    }
  }

  // 2. Check PATH for 'pali'
  const pathResult = await which('pali');
  if (pathResult) {
    return { path: pathResult, source: 'path' };
  }

  // 3. Check globalStorage cache
  const cached = path.join(context.globalStorageUri.fsPath, 'pali');
  if (await isExecutable(cached)) {
    return { path: cached, source: 'cache' };
  }

  // 4. Not found
  return { path: null, source: 'missing' };
}
```

### 2. Download Logic (`extension.js`)

```javascript
async function downloadAndInstallPali(context) {
  const platform = process.platform;
  const arch = process.arch;

  const target = getReleaseTarget(platform, arch);
  if (!target) {
    throw new Error(`Prebuilt binaries not available for ${platform}-${arch}`);
  }

  const version = 'latest'; // or pinned version
  const asset = releaseAssetName(target); // per-platform archive name
  const url = `https://github.com/cderivan/memory-mcp/releases/${version}/download/${asset}`;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Downloading pali binary...',
    cancellable: false
  }, async (progress) => {
    progress.report({ increment: 10 });
    const binary = await fetchBinary(url, progress);
    progress.report({ increment: 70 });
    const installedPath = await installBinary(context, binary);
    progress.report({ increment: 90 });
    await updateBinPathSetting(installedPath);
    progress.report({ increment: 100 });
    return installedPath;
  });
}
```

### 3. Release Target Mapping

| Platform | Architecture | Release Target | Asset |
| ---------- | -------------- | ---------------- | ---------------------------- |
| darwin | x64 | x86_64-apple-darwin | aarch64-apple-darwin.zip |
| darwin | arm64 | aarch64-apple-darwin | aarch64-apple-darwin.zip |
| linux | x64 | x86_64-unknown-linux-gnu | x86_64-unknown-linux-gnu.tgz |
| win32 | x64 | x86_64-pc-windows-msvc | pali.x86_64-pc-windows-msvc.zip |

### 4. Release Server URL

Base URL: `https://github.com/cderivan/memory-mcp/releases/{version}/download/`

Asset naming: one archive per platform — `aarch64-apple-darwin.zip`
(macOS, universal for arm64 and x64), `pali.x86_64-pc-windows-msvc.zip`
(Windows), and `x86_64-unknown-linux-gnu.tgz` (Linux). The macOS and Windows
archives are ZIPs; the Linux archive is a gzip-compressed tar. Each holds a
single executable, which the installer extracts and renames to the platform
binary name.

### 5. Settings Integration

```javascript
async function updateBinPathSetting(newPath) {
  const config = vscode.workspace.getConfiguration('pali');
  await config.update('binPath', newPath, vscode.ConfigurationTarget.Global);
  serverChanged.fire(); // Re-trigger MCP server definition
}
```

### 6. Notification Flow

```javascript
async function promptForDownload(context) {
  const action = await vscode.window.showInformationMessage(
    'Pali binary not found. Download and install it now?',
    { modal: true },
    'Download Now',
    'Open Settings',
    'Later'
  );

  switch (action) {
    case 'Download Now':
      await downloadAndInstallPali(context);
      break;
    case 'Open Settings':
      vscode.commands.executeCommand('workbench.action.openSettings', 'pali');
      break;
    case 'Later':
    case undefined:
      // Defer, will re-prompt on next activation
      break;
  }
}
```

## Data Flow

```text
User opens VS Code
       │
       ▼
Extension activates (onStartupFinished)
       │
       ▼
resolveBinary() called
       │
       ├─▶ binPath configured & valid ──▶ Use it
       │
       ├─▶ PATH has pali ──▶ Use it, update binPath setting
       │
       └─▶ Not found ──▶ promptForDownload()
                           │
                           ├─▶ "Download Now" ──▶ downloadAndInstallPali()
                           │                       │
                           │                       ├─▶ Fetch from release server
                           │                       ├─▶ Save to globalStorage/pali
                           │                       ├─▶ chmod +x
                           │                       ├─▶ Update binPath setting
                           │                       └─▶ serverChanged.fire()
                           │
                           ├─▶ "Open Settings" ──▶ Open pali settings
                           │
                           └─▶ "Later" ──▶ Defer
```

## Error Handling

| Failure Point | Handling |
| --------------- | ---------- |
| Network timeout | Retry once, then show error with manual URL |
| HTTP 404/403 | Show error with release page URL |
| Checksum mismatch | Delete partial, show error |
| Write permission denied | Show error, suggest manual install location |
| Binary not executable after install | chmod +x, verify, else re-download |
| Execution fails | Treat as corrupted, re-prompt |

## Configuration

No new settings. Uses existing:

- `pali.binPath` — updated automatically to globalStorage path

## Dependencies

No new npm dependencies required:

- `https` / `fetch` (built-in Node.js 18+)
- `fs/promises` (built-in)
- `path` (built-in)
- VS Code APIs: `globalStorageUri`, `window.showInformationMessage`, `window.withProgress`, `workspace.getConfiguration().update()`

## Security

- Download URL is hardcoded to known release server
- No user-supplied URLs
- Binary executed directly (no shell)
- Checksum verification: optional future enhancement (could fetch `.sha256` sidecar)

## Testing Strategy

1. Unit test `resolvePaliBinary` with mocked `fs` and `which`
2. Unit test `getReleaseTarget` for all platform/arch combos
3. Integration test: simulate missing binary, verify prompt shown
4. Integration test: mock download, verify binary installed to globalStorage
5. Integration test: verify binPath updated and serverChanged fired
6. E2E test: clean install of extension on machine without pali

## Future Enhancements

- Checksum verification against release SHA256
- Periodic update check (daily/weekly)
- Version pinning (extension version ↔ pali version)
- Windows support when CI adds it
- Background auto-update (non-blocking
