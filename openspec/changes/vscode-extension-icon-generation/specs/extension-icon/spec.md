# Specification: Extension Icon Generation

## Scope

VS Code extension icon generation and packaging.

## Requirements

### REQ-301: Generate SVG Icon

- **ID**: REQ-301
- **Description**: `generate-icon.mjs` creates `icon.svg` with neural network design
- **Rationale**: Scalable source asset

### REQ-302: Generate PNG Icon

- **ID**: REQ-302
- **Description**: `generate-icon.mjs` uses sharp to create 128x128 `icon.png`
- **Rationale**: VS Code marketplace requires PNG

### REQ-303: Build Integration

- **ID**: REQ-303
- **Description**: `npm run prepare` executes icon generation automatically
- **Rationale**: Zero-maintenance icon at install/pack time

### REQ-304: Package.json Icon Field

- **ID**: REQ-304
- **Description**: `package.json` declares `"icon": "icon.png"`
- **Rationale**: VS Code reads this for marketplace display

### REQ-305: Dev Dependency Only

- **ID**: REQ-305
- **Description**: `sharp` only in `devDependencies`
- **Rationale**: Not needed at runtime, reduces vsix size

### REQ-306: Gitignore PNG

- **ID**: REQ-306
- **Description**: `icon.png` in `.gitignore`, `icon.svg` committed
- **Rationale**: Generated artifacts not in repo; source reviewable

## Icon Design Spec

| Property | Value |
| ---------- | ------- |
| Canvas | 128x128 viewBox |
| Background | Rounded rect (rx=24), indigo→purple gradient |
| Nodes | 7 circles (3+2+2), semi-transparent white |
| Connections | White paths between layers |
| Format | SVG source, PNG 128x128 output |

## Acceptance Criteria

- [ ] `cd vscode-extension && npm install` generates icon.svg and icon.png
- [ ] `icon.png` is 128x128 PNG
- [ ] `icon.svg` contains gradient + neural network paths
- [ ] `package.json` has `"icon": "icon.png"`
- [ ] `package.json` has `"prepare": "node scripts/generate-icon.mjs"`
- [ ] `sharp` in `devDependencies` only
- [ ] `icon.png` in `.gitignore`
- [ ] `vsix` package includes `icon.png`
- [ ] Extension shows custom icon in VS Code extensions panel
