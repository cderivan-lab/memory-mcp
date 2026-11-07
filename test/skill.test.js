"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  installSkill,
  skillInstallPath,
  skillSourcePath,
  userSkillsDir,
} = require("../out/utils/lib");

const root = join(__dirname, "..");
const shippedSkill = join(root, "skills", "pali-memory", "SKILL.md");
const serverSource = fs.readFileSync(join(root, "pali", "src", "server.rs"), "utf8");
const skillSource = fs.readFileSync(shippedSkill, "utf8");

/** Tool names declared by the rmcp `#[tool(name = "...")]` macros. */
function registryTools(source) {
  return [...source.matchAll(/\[tool\(\s*name = "([^"]+)"/g)]
    .map((match) => match[1])
    .sort();
}

/** The skill's machine-checked list, next to the prose it describes. */
function documentedTools(source) {
  const marker = /<!-- pali-tools:([^>]*)-->/.exec(source);
  assert.ok(marker, "SKILL.md must declare <!-- pali-tools: ... -->");
  return marker[1].trim().split(/\s+/).filter(Boolean).sort();
}

test("the skill's tool list matches the MCP tool registry", () => {
  const registered = registryTools(serverSource);
  assert.ok(registered.length > 0, "server.rs must declare at least one tool");
  assert.deepEqual(
    documentedTools(skillSource),
    registered,
    "update the pali-tools list in skills/pali-memory/SKILL.md when a tool changes",
  );
});

test("the skill installs at user level and refreshes in place", async () => {
  const extensionRoot = join(tmpdir(), `pali-skill-ext-${Date.now()}`);
  const skills = join(tmpdir(), `pali-skill-home-${Date.now()}`);
  const source = skillSourcePath(extensionRoot);
  await mkdir(join(extensionRoot, "skills", "pali-memory"), { recursive: true });
  await writeFile(source, "name: pali-memory\n", "utf8");
  try {
    assert.equal(installSkill(extensionRoot, skills), "installed");
    assert.equal(await readFile(skillInstallPath(skills), "utf8"), "name: pali-memory\n");
    assert.equal(installSkill(extensionRoot, skills), "current");

    await writeFile(source, "name: pali-memory\nversion: 2\n", "utf8");
    assert.equal(
      installSkill(extensionRoot, skills),
      "installed",
      "an extension update refreshes the installed copy",
    );
    assert.equal(
      await readFile(skillInstallPath(skills), "utf8"),
      "name: pali-memory\nversion: 2\n",
    );
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
    await rm(skills, { recursive: true, force: true });
  }
});

test("uninstall removes the installed skill only when unchanged", async () => {
  const { removeSkill } = require("../out/uninstall");
  const dir = join(tmpdir(), `pali-uninstall-skill-${Date.now()}`);
  const target = join(dir, "pali-memory", "SKILL.md");
  const shipped = await readFile(shippedSkill, "utf8");
  await mkdir(join(dir, "pali-memory"), { recursive: true });
  try {
    assert.equal(removeSkill(dir), false, "a missing skill is not an error");

    await writeFile(target, `${shipped}\nhand edit`, "utf8");
    assert.equal(removeSkill(dir), false, "an edited skill is left alone");

    await writeFile(target, shipped, "utf8");
    assert.equal(removeSkill(dir), true);
    await assert.rejects(stat(target));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a write failure is reported as failed", async () => {
  const extensionRoot = join(tmpdir(), `pali-skill-ext-fail-${Date.now()}`);
  const skills = join(tmpdir(), `pali-skill-home-fail-${Date.now()}`);
  const source = skillSourcePath(extensionRoot);
  await mkdir(join(extensionRoot, "skills", "pali-memory"), { recursive: true });
  await writeFile(source, "name: pali-memory\n", "utf8");
  try {
    // A directory in the skill's place makes writeFileSync throw, so the
    // installer cannot leave the file and must report the failure.
    await mkdir(skillInstallPath(skills), { recursive: true });
    assert.equal(installSkill(extensionRoot, skills), "failed");
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
    await rm(skills, { recursive: true, force: true });
  }
});

test("the default install path sits in the user's skills directory", () => {
  assert.equal(
    skillInstallPath(),
    join(userSkillsDir(), "pali-memory", "SKILL.md"),
    "the installed skill lives under the user's copilot skills directory",
  );
});
