// Prepare the fixtures the UI e2e run needs.
//
// The click test asserts on the *model* offer, so activation must resolve a
// binary or it asks about the binary first. `pali.path` is seeded with a stub
// executable, which has to be an absolute path and therefore is generated per
// run rather than committed.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".e2e-ui");
mkdirSync(out, { recursive: true });

// Resolved by `isExecutable` during activation; never actually run.
const binary = join(out, process.platform === "win32" ? "pali.exe" : "pali");
writeFileSync(binary, "#!/bin/sh\nexit 0\n", "utf8");
chmodSync(binary, 0o755);

writeFileSync(
  join(out, "settings.json"),
  `${JSON.stringify({ "pali.path": binary, "pali.checkUpdates": false }, null, 2)}\n`,
  "utf8",
);

// A previous run may have installed the model into the test instance's
// globalStorage. That would remove the notification this suite clicks, so the
// extension's storage starts empty on every run.
const storage = resolve(process.env.PALI_E2E_STORAGE ?? join(root, "test-resources"));
rmSync(join(storage, "settings", "User", "globalStorage", "cderivan.pali-memory"), {
  recursive: true,
  force: true,
});

console.log(`e2e-ui: stub binary at ${binary}`);
