# Design

## Icon Concept

Neural network visualization representing memory/embedding connections:

- 3 layers of nodes (input → hidden → output)
- Connections between layers
- Blue-to-purple gradient (brand colors)
- Clean, recognizable at 16x16 through 512x512

## Generation Script

```javascript
// vscode-extension/scripts/generate-icon.mjs
import { writeFileSync } from 'fs';
import sharp from 'sharp';

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4F46E5"/>
      <stop offset="100%" stop-color="#9333EA"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="url(#bg)"/>
  <!-- Neural network nodes -->
  <g stroke="#fff" stroke-width="2" fill="none">
    <!-- Layer 1 (input) -->
    <circle cx="32" cy="32" r="8" fill="#fff" fill-opacity="0.2"/>
    <circle cx="32" cy="64" r="8" fill="#fff" fill-opacity="0.2"/>
    <circle cx="32" cy="96" r="8" fill="#fff" fill-opacity="0.2"/>
    <!-- Layer 2 (hidden) -->
    <circle cx="64" cy="48" r="8" fill="#fff" fill-opacity="0.3"/>
    <circle cx="64" cy="80" r="8" fill="#fff" fill-opacity="0.3"/>
    <!-- Layer 3 (output) -->
    <circle cx="96" cy="40" r="8" fill="#fff" fill-opacity="0.4"/>
    <circle cx="96" cy="88" r="8" fill="#fff" fill-opacity="0.4"/>
    <!-- Connections -->
    <path d="M40 32 L56 48 M40 64 L56 48 M40 64 L56 80 M40 96 L56 80"/>
    <path d="M72 48 L88 40 M72 80 L88 88"/>
  </g>
</svg>
`;

writeFileSync('icon.svg', svg);
await sharp(Buffer.from(svg)).resize(128, 128).png().toFile('icon.png');
```

## Build Integration

```json
// package.json
{
  "scripts": {
    "prepare": "node scripts/generate-icon.mjs",
    "compile": "tsc -p ./"
  },
  "icon": "icon.png",
  "devDependencies": {
    "sharp": "^0.33.0"
  }
}
```

- `prepare` runs automatically on `npm install` and `npm pack`
- `icon.png` committed to vsix but not git (gitignored)
- Source SVG committed for reviewability

## Output Assets

| File | Size | Use |
| ------ | ------ | ----- |
| `icon.svg` | ~2KB | Source, scalable |
| `icon.png` | ~4KB | VS Code marketplace (128x128) |
| In vsix | Included | Marketplace display |

## Color Palette

| Role | Hex | Usage |
| ------ | ----- | ------- |
| Primary | #4F46E5 | Gradient start (indigo) |
| Secondary | #9333EA | Gradient end (purple) |
| Node fill | #FFFFFF22-44 | Semi-transparent white |
| Connections | #FFFFFF | White lines |
