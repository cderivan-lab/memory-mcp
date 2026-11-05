// Minimal `.env` reader for the end-to-end launch scripts.
//
// Node runs these scripts directly, so there is no `dotenv` dependency to lean
// on. Values already present in the environment win over the file: a shell or
// CI export (`PALI_HOOKS_DIR=... npm run test:e2e`) must not be silently
// replaced by a developer's local `.env`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this module's location (`scripts/`). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixed env-file path shared by both e2e launchers: the repository-root
 * `.env`. Resolved from this module rather than `process.cwd()`, so the path a
 * run reads cannot depend on where npm was invoked.
 */
export const E2E_ENV_FILE = resolve(ROOT, ".env");

/** Load {@link E2E_ENV_FILE} and return its path, for callers that log it. */
export function loadE2eEnv() {
  loadEnv(E2E_ENV_FILE);
  return E2E_ENV_FILE;
}

/**
 * Load `file` into `process.env`, leaving variables that are already set
 * untouched. A missing file is normal: the e2e suites fall back to their own
 * throwaway directories.
 */
export function loadEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) process.env[key] = parseValue(raw);
  }
}

/** Strip surrounding quotes or a trailing `# comment` from one assignment. */
function parseValue(raw) {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end !== -1) return value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, "").trim();
}
