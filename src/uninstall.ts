// Runs from the `vscode:uninstall` script in package.json when VS Code
// uninstalls the extension. The hook file this extension writes points at
// `hooks/copilot-hooks.mjs` inside the extension directory, so leaving it
// behind makes every Copilot hook event fail with MODULE_NOT_FOUND once that
// directory is gone. The skill and the instructions file are the other
// artifacts that outlive the extension. Remove all three — and only what this
// extension wrote: a foreign hook config, a hand-edited skill, or a
// hand-edited instructions file survives.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INSTRUCTIONS_DIR, INSTRUCTIONS_FILE } from './utils/instructions';

/** Directory holding the user-level hook config; tests redirect it. */
function hooksDir(): string {
  return process.env.PALI_HOOKS_DIR || path.join(os.homedir(), '.copilot', 'hooks');
}

/** Directory holding user-level skills; tests redirect it. */
function skillsDir(): string {
  return process.env.PALI_SKILLS_DIR || path.join(os.homedir(), '.copilot', 'skills');
}

/** User-level Pali Memory instructions file; tests redirect it. */
function instructionsPath(): string {
  return (
    process.env.PALI_INSTRUCTIONS_PATH ||
    path.join(os.homedir(), ".copilot", INSTRUCTIONS_DIR, INSTRUCTIONS_FILE)
  );
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

/**
 * Delete the instructions file this extension installed. It is only ours when
 * it still matches the shipped copy: a hand edit is left alone, exactly like
 * the installed skill.
 */
export function removeInstructions(file: string = instructionsPath()): boolean {
  const source = path.join(__dirname, '..', INSTRUCTIONS_DIR, INSTRUCTIONS_FILE);
  let installed: string;
  let shipped: string;
  try {
    installed = fs.readFileSync(file, "utf8");
    shipped = fs.readFileSync(source, "utf8");
  } catch {
    return false;
  }
  if (installed !== shipped) return false;

  try {
    fs.rmSync(file, { force: true });
    // Remove the now-empty instructions directory, but leave anything else.
    try {
      fs.rmdirSync(path.dirname(file));
    } catch {
      // Not empty, or already gone: the file is what matters.
    }
    return true;
  } catch (error) {
    process.stderr.write(
      `pali: could not remove ${file}: ${(error as Error).message}\n`,
    );
    return false;
  }
}

/**
 * Delete the skill this extension installed. The skill is product
 * documentation, so it is only ours when it still matches the shipped copy:
 * a hand edit, or another tool's skill of the same name, is left alone.
 */
export function removeSkill(dir: string = skillsDir()): boolean {
  const target = path.join(dir, 'pali-memory', 'SKILL.md');
  const source = path.join(__dirname, '..', 'skills', 'pali-memory', 'SKILL.md');
  let installed: string;
  let shipped: string;
  try {
    installed = fs.readFileSync(target, 'utf8');
    shipped = fs.readFileSync(source, 'utf8');
  } catch {
    return false;
  }
  if (installed !== shipped) return false;

  try {
    fs.rmSync(target, { force: true });
    // Remove the now-empty skill directory, but leave anything else in it.
    try {
      fs.rmdirSync(path.dirname(target));
    } catch {
      // Not empty, or already gone: the file is what matters.
    }
    return true;
  } catch (error) {
    process.stderr.write(
      `pali: could not remove ${target}: ${(error as Error).message}\n`,
    );
    return false;
  }
}

if (require.main === module) {
  const removedHook = removeHookConfig();
  const removedSkill = removeSkill();
  const removedInstructions = removeInstructions();
  process.stderr.write(
    removedHook
      ? 'pali: removed the Copilot hook config\n'
      : 'pali: no Copilot hook config to remove\n',
  );
  process.stderr.write(
    removedSkill
      ? 'pali: removed the Pali Memory skill\n'
      : 'pali: no Pali Memory skill to remove\n',
  );
  process.stderr.write(
    removedInstructions
      ? 'pali: removed the Pali Memory instructions\n'
      : 'pali: no Pali Memory instructions to remove\n',
  );
}
