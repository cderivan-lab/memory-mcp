import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { E2E_ENV_FILE, loadEnv, loadE2eEnv } from "../scripts/load-env.mjs";

// Every key is namespaced so a developer's real `.env` or shell export cannot
// supply a value and make an assertion pass vacuously.
const PLAIN = "PALI_E2E_TEST_PLAIN";
const EXPORTED = "PALI_E2E_TEST_EXPORTED";
const QUOTED = "PALI_E2E_TEST_QUOTED";
const TRAILING = "PALI_E2E_TEST_TRAILING";
const BLANK = "PALI_E2E_TEST_BLANK";
const PREEXISTING = "PALI_E2E_TEST_PREEXISTING";
const KEYS = [PLAIN, EXPORTED, QUOTED, TRAILING, BLANK, PREEXISTING];

/** Run `body` with the loader keys cleared, restoring them afterwards. */
async function withCleanKeys(body) {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadEnv parses assignments, exports, quotes and comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pali-load-env-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "# a comment line",
        `${PLAIN}=plain`,
        `export ${EXPORTED}=exported`,
        `${QUOTED}="quoted value # not a comment"`,
        `${TRAILING}=trailing # trailing comment`,
        `${BLANK}=`,
        "this line is not an assignment",
      ].join("\n"),
      "utf8",
    );

    await withCleanKeys(() => {
      loadEnv(file);
      assert.equal(process.env[PLAIN], "plain");
      assert.equal(process.env[EXPORTED], "exported");
      assert.equal(process.env[QUOTED], "quoted value # not a comment");
      assert.equal(process.env[TRAILING], "trailing");
      assert.equal(process.env[BLANK], "");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv leaves variables the shell already exported untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pali-load-env-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, `${PREEXISTING}=from-file\n`, "utf8");

    await withCleanKeys(() => {
      process.env[PREEXISTING] = "from-shell";
      loadEnv(file);
      assert.equal(process.env[PREEXISTING], "from-shell");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv ignores a missing file", async () => {
  await withCleanKeys(() => {
    assert.doesNotThrow(() => loadEnv(join(tmpdir(), "pali-no-such-env-file")));
    assert.equal(process.env[PLAIN], undefined);
  });
});

test("the e2e env file is pinned at the repository root", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.ok(isAbsolute(E2E_ENV_FILE), "the path must not depend on the cwd");
  assert.equal(E2E_ENV_FILE, join(repoRoot, ".env"));
});

test("loadE2eEnv loads the pinned e2e env file and returns its path", () => {
  const saved = process.env[PLAIN];
  let backup;
  let hadBackup = false;
  try {
    backup = readFileSync(E2E_ENV_FILE, "utf8");
    hadBackup = true;
  } catch {
    // No pre-existing .env; restore by removing it.
  }
  delete process.env[PLAIN];
  try {
    writeFileSync(E2E_ENV_FILE, `${PLAIN}=e2e-loaded\n`, "utf8");
    const result = loadE2eEnv();
    assert.equal(result, E2E_ENV_FILE, "loadE2eEnv returns the pinned env file path");
    assert.equal(process.env[PLAIN], "e2e-loaded");
  } finally {
    if (saved === undefined) delete process.env[PLAIN];
    else process.env[PLAIN] = saved;
    if (hadBackup) writeFileSync(E2E_ENV_FILE, backup, "utf8");
    else rmSync(E2E_ENV_FILE);
  }
});
