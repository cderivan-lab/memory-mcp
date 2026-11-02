# VS Code Extension: Icon Generation

Adds programmatic icon generation for the VS Code extension.

## Files Added

- `vscode-extension/scripts/generate-icon.mjs` — Generates SVG + PNG icon
- `vscode-extension/icon.svg` — Source icon (committed)
- `vscode-extension/icon.png` — Generated icon (gitignored, in vsix)

## Files Modified

- `vscode-extension/package.json` — `prepare` script, `icon` field, `sharp` devDep
- `vscode-extension/CHANGELOG.md` — Icon generation entry
- `vscode-extension/README.md` — Icon generation documentation

## Icon Design

Neural network visualization:

- 3-layer node diagram (input → hidden → output)
- Indigo-to-purple gradient background
- Semi-transparent white nodes and connections
- Scalable SVG source, 128x128 PNG for marketplace

## Generation

```bash
cd vscode-extension
npm install  # Runs generate-icon.mjs via prepare script
```

Outputs:

- `icon.svg` — Vector source

- `icon.png` — 128x128 PNG for VS Code marketplace

## Package.json Changes

```json
{
  "icon": "icon.png",
  "scripts": {
    "prepare": "node scripts/generate-icon.mjs"
  },
  "devDependencies": {
    "sharp": "^0.33.0"
  }
}
```

- `prepare` runs on `npm install` and `npm pack`
- Icon included in `.vsix` but not git (gitignored)
