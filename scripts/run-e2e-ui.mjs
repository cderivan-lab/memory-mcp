// Run the UI e2e suite with its hooks installed into a throwaway directory.
//
// The extension writes a user-level Copilot hooks file. Without the override
// this suite would overwrite the developer's real ~/.copilot/hooks/pali.json
// with commands pointing at the test VSIX stub, so the run stays hermetic.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadE2eEnv } from "./load-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadE2eEnv();
const extestCli = join(root, "node_modules", "vscode-extension-tester", "out", "cli.js");

const child = spawn(
  process.execPath,
  [
    extestCli,
    "setup-and-run",
    join(root, "test", "e2e-ui", "download-notification.test.js"),
    "--code_settings",
    join(root, ".e2e-ui", "settings.json"),
    "--storage",
    process.env.PALI_E2E_STORAGE ?? join(root, "test-resources"),
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PALI_HOOKS_DIR: resolve(
        process.env.PALI_HOOKS_DIR ?? join(root, ".e2e-ui", "hooks"),
      ),
      PALI_INSTRUCTIONS_PATH: resolve(
        process.env.PALI_INSTRUCTIONS_PATH ??
        join(root, ".e2e-ui", "instructions", "pali-memory.instructions.md"),
      ),
      PALI_SKILLS_DIR: resolve(
        process.env.PALI_SKILLS_DIR ?? join(root, ".e2e-ui", "skills"),
      ),
    },
  },
);

child.on("error", (error) => {
  console.error(`e2e-ui: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
