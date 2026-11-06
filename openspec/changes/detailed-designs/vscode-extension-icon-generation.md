# Detailed Design: VS Code Extension Icon Generation

## Change: vscode-extension-icon-generation

### Purpose

Add a programmatic icon generator that creates a professional SVG/PNG icon at build time, making the extension distinguishable in the marketplace and extensions panel.

### New Capability: `extension-icon`

#### Icon Generator Design

- **Script**: `vscode-extension/scripts/generate-icon.mjs`
  - Node.js script generating SVG icon
  - Draws neural network node diagram (circles + connections)
  - Blue/purple gradient matching brand colors
  - Outputs `icon.svg` and `icon.png` (via sharp)
  - Runs at `npm run compile` via `prepare` script

- **Package.json contributions**:
  - `icon: "icon.png"` field
  - `scripts.prepare: "node scripts/generate-icon.mjs"`
  - `sharp` devDependency for PNG generation

### Design Decisions

#### 1. SVG Generation (generate-icon.mjs)

```javascript
// Generates an SVG with:
// - Neural network node diagram (circles + connections)
// - Blue/purple gradient matching brand colors
// - Professional size for VS Code extension icon
```

#### 2. PNG Generation

- Uses `sharp` to convert SVG to PNG at required resolution
- Generated at build time via `npm run prepare`
- No committed binary assets in repo

#### 3. Build Integration

- `prepare` script runs `node scripts/generate-icon.mjs`
- Generates both `icon.svg` and `icon.png`
- `icon.png` referenced in `package.json` `icon` field
- No runtime impact — generated at install/build time

### Impact

- Extension now shows custom icon in VS Code marketplace and extensions panel
- Icon generated at install/build time (no committed binaries)
- Minimal dependency: `sharp` only at dev time
- No runtime impact
- CI build includes icon generation step
