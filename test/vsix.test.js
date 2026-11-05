"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const extensionRoot = path.join(__dirname, "..");

/**
 * Read one file out of a ZIP archive by walking its central directory, so the
 * assertion runs on the shipped artifact without depending on `unzip`.
 */
function readZipEntry(archive, wanted) {
  let eocd = -1;
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let i = archive.length - 22; i >= earliest; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "VSIX has no end-of-central-directory record");

  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, "bad central directory entry");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = archive.subarray(start, start + compressedSize);
      if (method === 0) return data;
      assert.equal(method, 8, `unsupported compression method ${method} for ${name}`);
      return zlib.inflateRawSync(data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`VSIX has no entry ${wanted}`);
}

/** List every entry name in the archive from its central directory. */
function zipEntryNames(archive) {
  let eocd = -1;
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let i = archive.length - 22; i >= earliest; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "VSIX has no end-of-central-directory record");

  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, "bad central directory entry");
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt32LE(offset + 32);
    names.push(archive.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

// Regression: 0.1.0 shipped a manifest whose only registration path was an
// install-prompt command, so VS Code never listed the server. The packaged
// manifest must contribute the provider the code actually registers.
test(
  "packaged VSIX manifest declares the MCP server definition provider",
  { timeout: 300_000 },
  () => {
    const vsix = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pali-vsix-")),
      "pali-memory.vsix",
    );
    // The pinned vsce from devDependencies, the same binary the release
    // pipeline uses. Self-hosted Gitea is not a repository vsce recognises, so
    // the README's relative links need explicit bases or packaging aborts.
    const vsce = path.join(
      extensionRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "vsce.cmd" : "vsce",
    );
    execFileSync(
      vsce,
      [
        "package",
        "--out",
        vsix,
        "--baseContentUrl",
        "https://github.com/cderivan/memory-mcp/src/branch/main",
        "--baseImagesUrl",
        "https://github.com/cderivan/memory-mcp/raw/branch/main",
      ],
      // Windows .cmd shims cannot be spawned directly; route them through the shell.
      { cwd: extensionRoot, stdio: "pipe", shell: process.platform === "win32" },
    );

    const archive = fs.readFileSync(vsix);
    const manifest = JSON.parse(readZipEntry(archive, "extension/package.json").toString("utf8"));
    const source = fs.readFileSync(path.join(extensionRoot, "out", "extension.js"), "utf8");
    // The identifier has to survive compilation, whatever quoting tsc emits.
    const registeredId = /MCP_PROVIDER_ID\s*=\s*['"]([^'"]+)['"]/.exec(source)?.[1];

    assert.ok(registeredId, "out/extension.js must define MCP_PROVIDER_ID");
    const providers = manifest.contributes?.mcpServerDefinitionProviders ?? [];
    assert.equal(providers.length, 1, "manifest must contribute exactly one provider");
    assert.equal(
      providers[0].id,
      registeredId,
      "manifest provider id must match the id passed to registerMcpServerDefinitionProvider",
    );
    assert.equal(providers[0].label, "Pali Memory");
    const commands = (manifest.contributes?.commands ?? []).map((entry) => entry.command);
    assert.deepEqual(
      [...commands].sort(),
      [
        "pali.clearToken",
        "pali.index",
        "pali.install",
        "pali.restart",
        "pali.scan",
        "pali.setToken",
        "pali.update",
      ],
      "manifest must declare the token, install, update, restart, scan, and index commands",
    );
    assert.equal(
      manifest.scripts?.["vscode:uninstall"],
      "node ./out/uninstall.js",
      "uninstall must remove the hook config the extension wrote",
    );
    assert.ok(
      readZipEntry(archive, "extension/out/uninstall.js"),
      "the uninstall script must ship inside the VSIX",
    );
    assert.equal(
      manifest.contributes?.configuration?.properties?.["pali.pat"],
      undefined,
      "the token must not be a plaintext setting",
    );

    // Only runtime files ship. The retired per-event hook sources, their
    // tests, and the repo's own dev config are clutter a user would have to
    // trust; the extension runs copilot-hooks.mjs and pali-client.mjs only.
    const names = zipEntryNames(archive);
    assert.deepEqual(
      names.filter((name) => name.startsWith("extension/hooks/")).sort(),
      ["extension/hooks/copilot-hooks.mjs", "extension/hooks/pali-client.mjs"],
      "only the runtime hook modules ship",
    );
    assert.ok(
      readZipEntry(archive, "extension/skills/pali-memory/SKILL.md"),
      "the skill must ship so activation can install it for the user",
    );
    assert.ok(
      readZipEntry(archive, "extension/instructions/pali-memory.instructions.md"),
      "the memory instructions must ship so activation can copy them for the user",
    );
    for (const absent of [
      "extension/.vscode-test.mjs",
      "extension/.freebuff/project-id",
      "extension/tmp/vsix.log",
    ]) {
      assert.ok(!names.includes(absent), `VSIX must not ship ${absent}`);
    }
    assert.equal(
      names.filter((name) => name.startsWith("extension/tmp/")).length,
      0,
      "the project's scratch directory must not ship",
    );

    const shipped = readZipEntry(archive, "extension/out/extension.js").toString("utf8");
    assert.match(shipped, /registerMcpServerDefinitionProvider/);
    assert.match(shipped, /secrets\.get/, "the token must be read from secret storage");
    assert.doesNotMatch(shipped, /openExternal|pali\.installMcp/);
  },
);
