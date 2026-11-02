// Compiles the internal server crate and stages its binary in the extension's
// output directory. The extension is the product; the crate is a build input,
// so the binary ships inside the VSIX as out/bin/pali (out/bin/pali.exe).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.platform === 'win32' ? 'pali.exe' : 'pali';

// The repository root is the Cargo workspace, so this runs from `root` and
// resolves pali through the workspace manifest.
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'pali'], {
  cwd: root,
  stdio: 'inherit',
});

const built = path.join(root, 'target', 'release', exe);
const staged = path.join(root, 'out', 'bin', exe);
mkdirSync(path.dirname(staged), { recursive: true });
copyFileSync(built, staged);
if (process.platform !== 'win32') chmodSync(staged, 0o755);

console.log(`staged ${path.relative(root, staged)}`);
