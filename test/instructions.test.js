"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  installInstructions,
  instructionsSourcePath,
  userInstructionsPath,
} = require("../out/utils/lib");
const { removeInstructions } = require("../out/uninstall");

const root = join(__dirname, "..");
const shipped = fs.readFileSync(
  join(root, "instructions", "pali-memory.instructions.md"),
  "utf8",
);

function tempPath(name) {
  return join(tmpdir(), `pali-instructions-${process.pid}-${Date.now()}-${name}`);
}

/** A throwaway extension directory carrying the shipped instructions asset. */
async function makeExtension(asset = shipped) {
  const extensionRoot = tempPath("ext");
  await mkdir(join(extensionRoot, "instructions"), { recursive: true });
  await writeFile(instructionsSourcePath(extensionRoot), asset, "utf8");
  return extensionRoot;
}

test("the shipped rule uses the current instructions format and real tools", () => {
  assert.match(shipped, /^---\n/);
  assert.match(shipped, /^description: '.+'$/m);
  assert.match(shipped, /^applyTo: '\*\*'$/m);
  assert.match(shipped, /`recall`/);
  assert.match(shipped, /`note`/);
  assert.match(shipped, /`remember`/);
  assert.match(shipped, /`read`/);
  assert.doesNotMatch(shipped, /`retain`/, "retain is the Pali name, not ours");
  assert.doesNotMatch(shipped, /`reflect`/, "reflect is not implemented here");
});

test("install copies the shipped file and refreshes it in place", async () => {
  const extensionRoot = await makeExtension();
  const target = tempPath("install.md");
  try {
    assert.equal(installInstructions(extensionRoot, target), "installed");
    assert.equal(await readFile(target, "utf8"), shipped);
    assert.equal(installInstructions(extensionRoot, target), "current");

    const updated = `${shipped}\n<!-- version 2 -->\n`;
    await writeFile(instructionsSourcePath(extensionRoot), updated, "utf8");
    assert.equal(
      installInstructions(extensionRoot, target),
      "installed",
      "an extension update refreshes the installed copy",
    );
    assert.equal(await readFile(target, "utf8"), updated);
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
    await rm(target, { force: true });
  }
});

test("a missing shipped asset is reported without deleting the installed copy", async () => {
  const extensionRoot = tempPath("empty-ext");
  const target = tempPath("missing.md");
  try {
    assert.equal(installInstructions(extensionRoot, target), "missing");
    await assert.rejects(stat(target));
  } finally {
    await rm(target, { force: true });
  }
});

test("the install path honours PALI_INSTRUCTIONS_PATH", async () => {
  const extensionRoot = await makeExtension();
  const target = tempPath("override.md");
  const previous = process.env.PALI_INSTRUCTIONS_PATH;
  process.env.PALI_INSTRUCTIONS_PATH = target;
  try {
    assert.equal(userInstructionsPath(), target);
    assert.equal(installInstructions(extensionRoot), "installed");
    assert.equal(await readFile(target, "utf8"), shipped);
  } finally {
    if (previous === undefined) delete process.env.PALI_INSTRUCTIONS_PATH;
    else process.env.PALI_INSTRUCTIONS_PATH = previous;
    await rm(extensionRoot, { recursive: true, force: true });
    await rm(target, { force: true });
  }
});

test("uninstall removes the instructions file only when unchanged", async () => {
  const dir = tempPath("uninstall-dir");
  const target = join(dir, "pali-memory.instructions.md");
  await mkdir(dir, { recursive: true });
  try {
    assert.equal(removeInstructions(target), false, "a missing file is not an error");

    await writeFile(target, `${shipped}\nhand edit`, "utf8");
    assert.equal(removeInstructions(target), false, "an edited file is left alone");
    assert.equal(await readFile(target, "utf8"), `${shipped}\nhand edit`);

    await writeFile(target, shipped, "utf8");
    assert.equal(removeInstructions(target), true);
    await assert.rejects(stat(target));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
