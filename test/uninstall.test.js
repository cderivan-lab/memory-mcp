"use strict";

// Tests for src/uninstall.ts: the hook/skill/instructions removal logic and
// the CLI entry point run by `vscode:uninstall`.

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const { mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const {
  removeHookConfig,
  removeInstructions,
  removeSkill,
} = require("../out/uninstall");

const root = join(__dirname, "..");
const shippedSkill = fs.readFileSync(join(root, "skills", "pali-memory", "SKILL.md"), "utf8");
const shippedInstructions = fs.readFileSync(
  join(root, "instructions", "pali-memory.instructions.md"),
  "utf8",
);

function temp(name) {
  return join(tmpdir(), `pali-uninstall-${process.pid}-${Date.now()}-${name}`);
}

test("hook config with malformed JSON is left alone", async () => {
  const dir = temp("bad-json");
  const target = join(dir, "pali.json");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(target, "not json at all", "utf8");
    assert.equal(removeHookConfig(dir), false, "malformed JSON cannot be ours");
    assert.equal(await readFile(target, "utf8"), "not json at all");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeInstructions leaves a non-empty directory behind", async () => {
  const dir = temp("instr-dir");
  const file = join(dir, "pali-memory.instructions.md");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, shippedInstructions, "utf8");
    // A sibling file keeps the directory alive; rmdir must not throw.
    await writeFile(join(dir, "other.txt"), "keep", "utf8");
    assert.equal(removeInstructions(file), true);
    await assert.rejects(stat(file));
    assert.equal(await readFile(join(dir, "other.txt"), "utf8"), "keep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeSkill leaves a non-empty directory behind", async () => {
  const dir = temp("skill-dir");
  const target = join(dir, "pali-memory", "SKILL.md");
  await mkdir(join(dir, "pali-memory"), { recursive: true });
  try {
    await writeFile(target, shippedSkill, "utf8");
    await writeFile(join(dir, "pali-memory", "other.txt"), "keep", "utf8");
    assert.equal(removeSkill(dir), true);
    await assert.rejects(stat(target));
    assert.equal(await readFile(join(dir, "pali-memory", "other.txt"), "utf8"), "keep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeInstructions removes an emptied directory", async () => {
  const dir = temp("instr-empty-dir");
  const file = join(dir, "pali-memory.instructions.md");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, shippedInstructions, "utf8");
    assert.equal(removeInstructions(file), true);
    await assert.rejects(stat(dir), "the empty instructions directory is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeSkill removes an emptied skill directory", async () => {
  const dir = temp("skill-empty-dir");
  const target = join(dir, "pali-memory", "SKILL.md");
  await mkdir(join(dir, "pali-memory"), { recursive: true });
  try {
    await writeFile(target, shippedSkill, "utf8");
    assert.equal(removeSkill(dir), true);
    await assert.rejects(stat(join(dir, "pali-memory")), "the empty skill dir is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI entry point removes the artifacts it owns", async () => {
  const hooksDir = temp("cli-hooks");
  const skillsDir = temp("cli-skills");
  const instructionsFile = temp("cli-instr.md");
  await mkdir(hooksDir, { recursive: true });
  await mkdir(join(skillsDir, "pali-memory"), { recursive: true });
  await writeFile(join(hooksDir, "pali.json"),
    JSON.stringify({
      version: 1,
      hooks: { agentStop: [{ bash: "node '/ext/hooks/copilot-hooks.mjs' stop" }] },
    }),
    "utf8",
  );
  await writeFile(join(skillsDir, "pali-memory", "SKILL.md"), shippedSkill, "utf8");
  await writeFile(instructionsFile, shippedInstructions, "utf8");

  const env = {
    ...process.env,
    PALI_HOOKS_DIR: hooksDir,
    PALI_SKILLS_DIR: skillsDir,
    PALI_INSTRUCTIONS_PATH: instructionsFile,
  };
  const { stderr } = await execFileAsync(process.execPath, [join(__dirname, "..", "out", "uninstall.js")], { env });
  try {
    assert.match(stderr, /removed the Copilot hook config/);
    assert.match(stderr, /removed the Pali Memory skill/);
    assert.match(stderr, /removed the Pali Memory instructions/);
    await assert.rejects(stat(join(hooksDir, "pali.json")));
    await assert.rejects(stat(join(skillsDir, "pali-memory", "SKILL.md")));
    await assert.rejects(stat(instructionsFile));
  } finally {
    await rm(hooksDir, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
    await rm(instructionsFile, { force: true });
  }
});

test("the CLI entry point reports when there is nothing to remove", async () => {
  const env = {
    ...process.env,
    PALI_HOOKS_DIR: temp("cli-noop-hooks"),
    PALI_SKILLS_DIR: temp("cli-noop-skills"),
    PALI_INSTRUCTIONS_PATH: temp("cli-noop-instr.md"),
  };
  const { stderr } = await execFileAsync(process.execPath, [join(__dirname, "..", "out", "uninstall.js")], { env });
  assert.match(stderr, /no Copilot hook config to remove/);
  assert.match(stderr, /no Pali Memory skill to remove/);
  assert.match(stderr, /no Pali Memory instructions to remove/);
});

test("the CLI entry point falls back to the home dir default paths", async () => {
  // With no PALI_* env vars set, the entry point targets ~/.copilot under
  // HOME. Pointing HOME at a throwaway directory exercises those defaults
  // (hooksDir, skillsDir, instructionsPath) without touching the real home.
  const home = temp("cli-home");
  await mkdir(join(home, ".copilot"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ["PALI_HOOKS_DIR", "PALI_SKILLS_DIR", "PALI_INSTRUCTIONS_PATH"]) {
    delete env[key];
  }
  const { stderr } = await execFileAsync(process.execPath, [join(__dirname, "..", "out", "uninstall.js")], { env });
  try {
    assert.match(stderr, /no Copilot hook config to remove/);
    assert.match(stderr, /no Pali Memory skill to remove/);
    assert.match(stderr, /no Pali Memory instructions to remove/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
