import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@vscode/test-cli";

// The e2e suite asserts on `.github/hooks/pali.json`, which activation writes
// into the open folder. Each run gets a fresh fixture so a leftover profile
// from an earlier run cannot satisfy (or fail) an assertion.
const workspace = mkdtempSync(join(tmpdir(), "pali-e2e-workspace-"));
mkdirSync(join(workspace, ".vscode"), { recursive: true });
writeFileSync(join(workspace, ".vscode", "settings.json"), "{}\n");
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

export default defineConfig({
	files: "test/e2e/**/*.test.js",
	workspaceFolder: workspace,
	mocha: { timeout: 60_000 },
});
