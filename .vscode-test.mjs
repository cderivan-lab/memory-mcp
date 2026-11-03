import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

// The e2e suite asserts on the user-level hooks file activation writes. Each
// run gets a fresh workspace so a leftover hook profile from an earlier run
// cannot satisfy (or fail) an assertion, and a throwaway PALI_HOOKS_DIR so the
// real ~/.copilot/hooks is never written by a test.
const workspace = mkdtempSync(join(tmpdir(), "pali-e2e-workspace-"));
mkdirSync(join(workspace, ".vscode"), { recursive: true });
writeFileSync(join(workspace, ".vscode", "settings.json"), "{}\n");
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

const hooks = mkdtempSync(join(tmpdir(), "pali-e2e-hooks-"));
process.on("exit", () => rmSync(hooks, { recursive: true, force: true }));

export default defineConfig({
	files: "test/e2e/**/*.test.js",
	workspaceFolder: workspace,
	env: { ...process.env, PALI_HOOKS_DIR: hooks },
	mocha: { timeout: 60_000 },
});
