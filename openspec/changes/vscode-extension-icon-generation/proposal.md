# Proposal

## Why

The VS Code extension had no icon, making it indistinguishable in the marketplace and extensions panel. This commit adds a programmatic icon generator that creates a professional SVG/PNG icon at build time.

## What Changes

### Added

- **vscode-extension/scripts/generate-icon.mjs**: Node.js script generating SVG icon
  - Draws neural network node diagram (circles + connections)
  - Blue/purple gradient matching brand colors
  - Outputs `icon.svg` and `icon.png` (via sharp)
  - Runs at `npm run compile` via `prepare` script

- **vscode-extension/package.json**:
  - Added `icon: "icon.png"` field
  - Added `scripts.prepare: "node scripts/generate-icon.mjs"`
  - Added `sharp` devDependency for PNG generation

- **vscode-extension/README.md**: Documented icon generation

### Modified

- **vscode-extension/CHANGELOG.md**: Added icon generation entry

## Capabilities

### New Capabilities

- `extension-icon`: Professional icon displayed in marketplace and extensions panel
- `icon-generation`: Build-time icon generation from code (no binary assets in repo)

## Impact

- Extension now shows custom icon in VS Code marketplace
- Icon generated at install/build time (no committed binaries)
- Minimal dependency (sharp only at dev time)
- No runtime impact
