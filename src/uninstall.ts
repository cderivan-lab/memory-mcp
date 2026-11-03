// Runs from the `vscode:uninstall` script in package.json when VS Code
// uninstalls the extension. The hook file this extension writes points at
// `hooks/copilot-hooks.mjs` inside the extension directory, so leaving it
// behind makes every Copilot hook event fail with MODULE_NOT_FOUND once that
// directory is gone. Remove that file — and only that file.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Directory holding the user-level hook config; tests redirect it. */
function hooksDir(): string {
  return process.env.PALI_HOOKS_DIR || path.join(os.homedir(), '.copilot', 'hooks');
}

/**
 * True when `body` is the hook file this extension writes: hook entries whose
 * commands run `copilot-hooks.mjs`. Anything else at the path belongs to
 * another tool and must survive the uninstall.
 */
function isPaliHookConfig(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { hooks?: Record<string, unknown> };
    const hooks = parsed?.hooks;
    if (!hooks || typeof hooks !== 'object') return false;
    return Object.values(hooks).some(
      (entries) =>
        Array.isArray(entries) &&
        entries.some((entry) => {
          const commands = entry as { bash?: unknown; powershell?: unknown };
          return [commands?.bash, commands?.powershell].some(
            (value) =>
              typeof value === 'string' && value.includes('copilot-hooks.mjs'),
          );
        }),
    );
  } catch {
    return false;
  }
}

/**
 * Delete the extension's Copilot hook config from `dir`, returning true when a
 * file was removed. A missing file is not an error: the extension never wrote
 * one, or an earlier uninstall already cleaned it up.
 */
export function removeHookConfig(dir: string = hooksDir()): boolean {
  const target = path.join(dir, 'pali.json');
  let body: string;
  try {
    body = fs.readFileSync(target, 'utf8');
  } catch {
    return false;
  }
  if (!isPaliHookConfig(body)) return false;

  try {
    fs.rmSync(target, { force: true });
    return true;
  } catch (error) {
    process.stderr.write(
      `pali: could not remove ${target}: ${(error as Error).message}\n`,
    );
    return false;
  }
}

if (require.main === module) {
  const removed = removeHookConfig();
  process.stderr.write(
    removed
      ? 'pali: removed the Copilot hook config\n'
      : 'pali: no Copilot hook config to remove\n',
  );
}
