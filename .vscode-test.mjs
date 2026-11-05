import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "@vscode/test-cli";
import { loadE2eEnv } from "./scripts/load-env.mjs";

// `.env` only fills variables the shell/CI left unset, so an explicit
// `PALI_HOOKS_DIR=... npm run test:e2e` still wins. `.env.example` documents
// the keys; `loadE2eEnv` pins the file at the repository root regardless of
// the working directory.
loadE2eEnv();

// Directories this run created; a configured path from `.env` is the
// developer's, so it is never deleted on exit.
const scratch = [];
process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// The e2e suite asserts on the user-level hooks file activation writes. Each
// run gets a fresh workspace so a leftover hook profile from an earlier run
// cannot satisfy (or fail) an assertion, and a throwaway PALI_HOOKS_DIR so the
// real ~/.copilot/hooks is never written by a test.
const workspace = scratchDir("pali-e2e-workspace-");
mkdirSync(join(workspace, ".vscode"), { recursive: true });
writeFileSync(join(workspace, ".vscode", "settings.json"), "{}\n");

const hooks = process.env.PALI_HOOKS_DIR
  ? resolve(process.env.PALI_HOOKS_DIR)
  : scratchDir("pali-e2e-hooks-");
mkdirSync(hooks, { recursive: true });

const instructions = process.env.PALI_INSTRUCTIONS_PATH
  ? resolve(process.env.PALI_INSTRUCTIONS_PATH)
  : join(scratchDir("pali-e2e-instructions-"), "pali-memory.instructions.md");
mkdirSync(dirname(instructions), { recursive: true });

// The uninstall test runs the extension's real uninstall script, which deletes
// the installed skill. Keep that copy out of the developer's `~/.copilot`
// alongside the hooks and instructions files it also removes.
const skills = process.env.PALI_SKILLS_DIR
  ? resolve(process.env.PALI_SKILLS_DIR)
  : scratchDir("pali-e2e-skills-");
mkdirSync(skills, { recursive: true });

export default defineConfig({
	files: "test/e2e/**/*.test.js",
	workspaceFolder: workspace,
	env: {
		...process.env,
		PALI_HOOKS_DIR: hooks,
		PALI_INSTRUCTIONS_PATH: instructions,
		PALI_SKILLS_DIR: skills,
	},
	mocha: { timeout: 60_000 },
});
