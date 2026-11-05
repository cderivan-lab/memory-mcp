"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildHookConfig,
  hookConfigBody,
  mcpServerDefinition,
  getReleaseTarget,
  releaseUrl,
  workspaceBootstrapCommand,
  workspaceBootstrapSummary,
} = require("../out/utils/lib");
const {
  binaryName,
  checkUpdates,
  extractBinaryFromArchive,
  installLatest,
  installModel,
  MODEL_FILES,
  modelDir,
  modelPathProblem,
  parseLfsPointer,
  prepare,
  releaseAssetName,
  resolveModelDir,
} = require("../out/utils/install_pali");
const { log, normalizeLogLevel, rustLogFilter } = require("../out/utils/logger");

const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { chmodSync } = require("node:fs");
const { mkdir, readFile, stat, writeFile, rm } = require("node:fs/promises");

const settings = {
  binPath: "/opt/pali bin/pali",
  repoPath: "/tmp/my repo",
  remoteUrl: "https://example.com/mem.git",
  remoteSync: true,
  branch: "trunk",
  scope: "org/team",
};

const token = "ghp_example";

test("hook config wires the three Copilot events", () => {
  const config = buildHookConfig("/ext", settings);

  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    "agentStop",
    "sessionStart",
    "userPromptTransformed",
  ]);

  for (const [event, entries] of Object.entries(config.hooks)) {
    assert.equal(entries.length, 1, event);
    const [entry] = entries;
    assert.equal(entry.type, "command", event);
    assert.match(entry.bash, /copilot-hooks\.mjs/, event);
    assert.match(entry.powershell, /copilot-hooks\.mjs/, event);
    assert.ok(entry.timeoutSec >= 30, event);
  }
});

test("hook commands carry local settings and never the remote URL", () => {
  const entry = buildHookConfig("/ext", settings).hooks.sessionStart[0];

  assert.match(entry.bash, /PALI_BIN='\/opt\/pali bin\/pali'/);
  assert.match(entry.bash, /PALI_REPO_PATH='\/tmp\/my repo'/);
  assert.match(entry.bash, /PALI_SCOPE='org\/team'/);
  assert.match(entry.powershell, /\$env:PALI_SCOPE='org\/team';/);
  assert.doesNotMatch(entry.bash, /PALI_REMOTE_URL|PALI_BRANCH/);
  assert.doesNotMatch(entry.powershell, /PALI_REMOTE_URL|PALI_BRANCH/);
});

test("hook commands carry the configured log level", () => {
  const entry = buildHookConfig("/ext", { ...settings, logLevel: "debug" }).hooks.agentStop[0];

  assert.match(entry.bash, /PALI_HOOK_LOG_LEVEL='debug'/);
  assert.match(entry.powershell, /\$env:PALI_HOOK_LOG_LEVEL='debug';/);

  // An unset level is omitted, leaving the hooks on their own default.
  const bare = buildHookConfig("/ext", settings).hooks.agentStop[0];
  assert.doesNotMatch(bare.bash, /PALI_HOOK_LOG_LEVEL/);
  assert.doesNotMatch(bare.powershell, /PALI_HOOK_LOG_LEVEL/);
});

test("hook commands exit quietly when the extension directory is gone", () => {
  // Regression: a hook file left behind by uninstall or an update pointed at a
  // directory VS Code had deleted, so node failed to load the entry point and
  // every event crashed with MODULE_NOT_FOUND.
  const entry = buildHookConfig("/ext", settings).hooks.sessionStart[0];

  assert.match(
    entry.bash,
    /^\[ -f '\/ext\/hooks\/copilot-hooks\.mjs' \] \|\| exit 0; PALI_BIN=/,
    "bash must skip the hook when the script is missing",
  );
  assert.match(
    entry.powershell,
    /^if \(-not \(Test-Path -LiteralPath '\/ext\/hooks\/copilot-hooks\.mjs'\)\) \{ exit 0 \}; \$env:PALI_BIN=/,
    "PowerShell must skip the hook when the script is missing",
  );

  // A present script still runs the same event mode.
  assert.match(entry.bash, /copilot-hooks\.mjs' session-start$/);
  assert.match(entry.powershell, /copilot-hooks\.mjs' session-start$/);

  // The guard must not hide the profile from the hook environment.
  assert.match(entry.bash, /PALI_SCOPE='org\/team'/);
});

test("single quotes are escaped per shell", () => {
  const entry = buildHookConfig("/ext", { ...settings, binPath: "pali's bin" }).hooks.agentStop[0];

  assert.match(entry.bash, /PALI_BIN='pali'\\''s bin'/);
  assert.match(entry.powershell, /\$env:PALI_BIN='pali''s bin';/);
});

test("hook config body is stable parseable JSON", () => {
  const body = hookConfigBody("/ext", settings);
  const parsed = JSON.parse(body);

  assert.equal(body, hookConfigBody("/ext", settings));
  assert.equal(parsed.version, 1);
  assert.ok(parsed.hooks.agentStop[0].timeoutSec > parsed.hooks.sessionStart[0].timeoutSec);
});

test("MCP definition points at the configured stdio server", () => {
  assert.deepEqual(mcpServerDefinition(settings, token), {
    label: "Pali Memory",
    command: "/opt/pali bin/pali",
    args: ["serve"],
    env: {
      // The server always runs with ANSI colour off; MCP diagnostics are read
      // as plain text in the output channel.
      NO_COLOR: "1",
      PALI_BRANCH: "trunk",
      PALI_REPO_PATH: "/tmp/my repo",
      PALI_REMOTE_URL: "https://example.com/mem.git",
      PALI_REQUIRE_REMOTE_SYNC: "true",
      PALI_GIT_TOKEN: "ghp_example",
    },
  });
});

test("remoteSync exports PALI_REQUIRE_REMOTE_SYNC only when enabled", () => {
  const on = mcpServerDefinition(settings, token);
  // The clap argument is a value-taking bool: `true`/`false`, not `1`.
  assert.equal(on.env.PALI_REQUIRE_REMOTE_SYNC, "true");

  const off = mcpServerDefinition({ ...settings, remoteSync: false }, token);
  assert.equal(off.env.PALI_REQUIRE_REMOTE_SYNC, undefined);
});

test("MCP definition exports the log level as a scoped RUST_LOG filter", () => {
  const debug = mcpServerDefinition({ ...settings, logLevel: "debug" }, token);
  assert.equal(debug.env.RUST_LOG, "pali=debug,info");

  const warn = mcpServerDefinition({ ...settings, logLevel: "warn" }, token);
  assert.equal(warn.env.RUST_LOG, "pali=warn");

  // No level configured means no RUST_LOG, so the server keeps its own default.
  const bare = mcpServerDefinition(settings, token);
  assert.equal(bare.env.RUST_LOG, undefined);
});

test("token is passed only for HTTPS remotes", () => {
  const https = mcpServerDefinition(
    { ...settings, remoteUrl: "https://example.com/mem.git" },
    token,
  );
  assert.equal(https.env.PALI_GIT_TOKEN, token);

  const local = mcpServerDefinition({ ...settings, remoteUrl: "/srv/memories.git" }, token);
  assert.equal(local.env.PALI_REMOTE_URL, "/srv/memories.git");
  assert.equal(local.env.PALI_GIT_TOKEN, undefined);
});

// --- Workspace bootstrap ---------------------------------------------------
//
// `Pali: Scan Workspace` and `Pali: Index Workspace` shell out to the CLI's
// bootstrap subcommands. The invocation is pure so the flags and the model
// handoff can be pinned without spawning the binary.

test("scan runs against the workspace folder and needs no model", () => {
  const invocation = workspaceBootstrapCommand("scan", settings, "/work/repo");

  assert.deepEqual(invocation.args, ["scan", "--workspace", "/work/repo"]);
  assert.equal(invocation.command, "/opt/pali bin/pali");
  assert.equal(invocation.env.PALI_MODEL_DIR, undefined);
  // Scan artifacts default to <workspace>/.pali, so no --artifacts is needed
  // and nothing is written into the memory repository.
  assert.doesNotMatch(invocation.args.join(" "), /--artifacts/);
});

test("index hands the embedding model to the CLI", () => {
  const installed = workspaceBootstrapCommand(
    "index",
    { ...settings, modelDir: "/storage/models/bge-small-en-v1.5" },
    "/work/repo",
  );
  assert.deepEqual(installed.args, ["index", "--workspace", "/work/repo"]);
  assert.equal(installed.env.PALI_MODEL_DIR, "/storage/models/bge-small-en-v1.5");

  // An explicit pali.modelPath wins, matching the server definition.
  const configured = workspaceBootstrapCommand(
    "index",
    { ...settings, modelPath: "/custom/models", modelDir: "/storage/models/bge-small-en-v1.5" },
    "/work/repo",
  );
  assert.equal(configured.env.PALI_MODEL_DIR, "/custom/models");
});

test("scan carries blame, size, and memory settings", () => {
  const defaults = workspaceBootstrapCommand(
    "scan",
    { ...settings, scanSaveMemories: true, repoPath: "", scope: "" },
    "/work/repo",
  );
  assert.deepEqual(defaults.args, [
    "scan",
    "--workspace",
    "/work/repo",
    "--save-memories",
  ]);
  assert.equal(defaults.env.PALI_MODEL_DIR, undefined, "scanning never loads the model");

  const configured = workspaceBootstrapCommand(
    "scan",
    {
      ...settings,
      scanSaveMemories: true,
      scanBlame: true,
      scanMaxFileBytes: 1048576,
      repoPath: "/memories",
      scope: "my-repo",
    },
    "/work/repo",
  );
  assert.deepEqual(configured.args, [
    "scan",
    "--workspace",
    "/work/repo",
    "--blame",
    "--max-file-bytes",
    "1048576",
    "--save-memories",
    "--repo-path",
    "/memories",
    "--scope",
    "my-repo",
  ]);

  // With saving off, the memory-repository flags stay out entirely.
  const artifactsOnly = workspaceBootstrapCommand(
    "scan",
    { ...settings, scanSaveMemories: false, repoPath: "/memories", scope: "my-repo" },
    "/work/repo",
  );
  assert.deepEqual(artifactsOnly.args, ["scan", "--workspace", "/work/repo"]);
});

test("every bootstrap subcommand carries the configured log level", () => {
  for (const kind of ["scan", "index"]) {
    const invocation = workspaceBootstrapCommand(
      kind,
      { ...settings, logLevel: "debug" },
      "/work/repo",
    );
    assert.equal(invocation.env.RUST_LOG, "pali=debug,info", kind);
  }
});

test("bootstrap summaries report the artifacts the run produced", () => {
  assert.equal(
    workspaceBootstrapSummary(
      "scan",
      JSON.stringify({ files: 12, sensitive: 2, findings: 3, report: "/w/.pali/scan.json" }),
    ),
    "Pali: scanned 12 files (2 sensitive, 3 potential secrets). Report: /w/.pali/scan.json",
  );
  assert.equal(
    workspaceBootstrapSummary(
      "index",
      JSON.stringify({ files: 12, chunks: 40, index: "/w/.pali/index" }),
    ),
    "Pali: indexed 40 chunks from 12 files. Index: /w/.pali/index",
  );

  assert.equal(
    workspaceBootstrapSummary(
      "scan",
      JSON.stringify({
        repositories: 1,
        accepted_files: 12,
        findings: 3,
        insights: "/w/.pali/insights.json",
      }),
    ),
    "Pali: scanned 12 files (3 findings). Insights: /w/.pali/insights.json",
  );

  // A binary that prints something other than JSON must not hide its output.
  assert.equal(workspaceBootstrapSummary("scan", "plain summary\n"), "plain summary");
});

test("getReleaseTarget maps supported platforms", () => {
  assert.equal(getReleaseTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(getReleaseTarget("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(getReleaseTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(getReleaseTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(getReleaseTarget("linux", "arm64"), null);
});

function makeContext() {
  return { globalStoragePath: join(tmpdir(), "pali-test-storage-" + Date.now()) };
}

test("resolvePaliBinary returns missing when nothing found", async () => {
  const ctx = makeContext();
  await mkdir(ctx.globalStoragePath, { recursive: true });
  try {
    const result = await require("../out/utils/lib").resolvePaliBinary(ctx, {
      binPath: "pali-nonexistent-xyz",
    });
    assert.equal(result.source, "missing");
    assert.equal(result.path, null);
  } finally {
    await rm(ctx.globalStoragePath, { recursive: true, force: true });
  }
});

test("resolvePaliBinary finds configured binPath", async () => {
  const ctx = makeContext();
  const binDir = join(tmpdir(), `pali-test-bin-${Date.now()}`);
  const binPath = join(binDir, binaryName());
  await mkdir(binDir, { recursive: true });
  await writeFile(binPath, "#!/bin/sh\necho hi\n", "utf8");
  chmodSync(binPath, 0o755);
  try {
    const result = await require("../out/utils/lib").resolvePaliBinary(ctx, { binPath });
    assert.equal(result.source, "configured");
    assert.equal(result.path, binPath);
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

test("resolvePaliBinary finds cached binary in globalStorage", async () => {
  const ctx = makeContext();
  const cached = join(ctx.globalStoragePath, binaryName());
  await mkdir(ctx.globalStoragePath, { recursive: true });
  await writeFile(cached, "#!/bin/sh\necho hi\n", "utf8");
  chmodSync(cached, 0o755);
  try {
    const result = await require("../out/utils/lib").resolvePaliBinary(ctx, {
      binPath: "pali-nonexistent-xyz",
    });
    assert.equal(result.source, "cache");
    assert.equal(result.path, cached);
  } finally {
    await rm(ctx.globalStoragePath, { recursive: true, force: true });
  }
});

test("a bundled binary is preferred over PATH and the cache", async () => {
  const ctx = makeContext();
  const extensionRoot = join(tmpdir(), `pali-test-bundle-${Date.now()}`);
  const bundled = join(extensionRoot, "out", "bin", binaryName());
  await mkdir(join(extensionRoot, "out", "bin"), { recursive: true });
  await writeFile(bundled, "#!/bin/sh\necho hi\n", "utf8");
  chmodSync(bundled, 0o755);
  try {
    const resolved = await require("../out/utils/lib").resolvePaliBinary(
      { globalStoragePath: ctx.globalStoragePath, bundledPath: bundled },
      { binPath: "pali-nonexistent-xyz" },
    );
    assert.equal(resolved.source, "bundled");
    assert.equal(resolved.path, bundled);
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
  }
});

test("releaseUrl defaults to the newest GitHub Enterprise release", () => {
  assert.equal(
    releaseUrl("aarch64-apple-darwin"),
    "https://github.com/cderivan/memory-mcp/releases/latest/download/aarch64-apple-darwin.zip",
  );
});

test("releaseAssetName maps each target to the published asset", () => {
  // macOS ships one universal archive used for both arm64 and x64.
  assert.equal(releaseAssetName("aarch64-apple-darwin"), "aarch64-apple-darwin.zip");
  assert.equal(releaseAssetName("x86_64-apple-darwin"), "aarch64-apple-darwin.zip");
  // Windows is a zip prefixed with the binary name.
  assert.equal(releaseAssetName("x86_64-pc-windows-msvc"), "pali.x86_64-pc-windows-msvc.zip");
  // Linux x64 is a tarball.
  assert.equal(releaseAssetName("x86_64-unknown-linux-gnu"), "x86_64-unknown-linux-gnu.tgz");
});

test("releaseUrl pins a version and keeps the archive layout", () => {
  assert.equal(
    releaseUrl("x86_64-pc-windows-msvc", "v1.0.0"),
    "https://github.com/cderivan/memory-mcp/releases/v1.0.0/download/pali.x86_64-pc-windows-msvc.zip",
  );
});

test("update checks ask the REST API for the newest release tag", async () => {
  // Regression: the API URL was built from the web host, yielding
  // github.com/api/v3/repos/... — GitHub Enterprise's path, which answers 404
  // on github.com. Every check came back empty, so no update prompt ever fired.
  const storage = join(tmpdir(), `pali-test-update-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  await writeFile(
    join(storage, "maintenance.json"),
    JSON.stringify({ installedVersion: "v1.0.0", checkUpdates: true }),
    "utf8",
  );

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({ tag_name: "v1.4.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const updates = [];
  const ui = makeInstallUi(storage);
  ui.promptUpdate = async (oldVersion, newVersion) =>
    updates.push([oldVersion, newVersion]);
  try {
    await checkUpdates(true, ui);

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://api.github.com/repos/cderivan/memory-mcp/releases/latest",
    );
    assert.equal(requests[0].headers.Authorization, "Bearer test-token");
    assert.deepEqual(updates, [["v1.0.0", "v1.4.0"]], "a newer tag is offered to the user");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a missing binary is offered for download even when update checks are off", async () => {
  // Regression: the offer used to be gated on `checkUpdates`, so an install
  // with update prompts dismissed could never ask for the binary it needs.
  const storage = join(tmpdir(), `pali-test-prepare-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const prompts = [];
  const ui = {
    paliPath: "pali-nonexistent-xyz",
    storagePath: storage,
    extensionPath: join(tmpdir(), `pali-test-ext-${Date.now()}`),
    error: (message) => assert.fail(`unexpected error: ${message}`),
    info: () => { },
    command: () => { },
    choose: async (prompt) => {
      prompts.push(prompt);
      return "Later";
    },
    slow: (_, promise) => promise,
    progress: (_, __, body) => body(() => { }),
    localize: (message) => message,
    shouldReuse: async () => undefined,
    promptReload: async () => { },
    promptUpdate: async () => { },
  };
  try {
    const result = await prepare(ui, false);

    assert.equal(result.paliPath, null);
    assert.equal(result.source, "missing");
    assert.equal(prompts.length, 1, "the install offer must not depend on checkUpdates");
    assert.match(prompts[0], /binary was not found/);
    assert.equal(result.modelDir, null, "no model prompt without a startable server");
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("a usable pali.modelPath suppresses the model download offer", async () => {
  // Regression: activation only looked in extension storage, so a user who
  // provisioned the model through `pali.modelPath` was asked to download it
  // again on every activation.
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const storage = join(tmpdir(), `pali-test-configured-storage-${suffix}`);
  const configured = join(tmpdir(), `pali-test-configured-model-${suffix}`);
  await mkdir(configured, { recursive: true });
  for (const name of MODEL_FILES) {
    await writeFile(join(configured, name), "{}\n", "utf8");
  }

  const prompts = [];
  const ui = {
    paliPath: process.execPath,
    storagePath: storage,
    extensionPath: join(tmpdir(), `pali-test-ext-${suffix}`),
    modelPath: configured,
    error: (message) => assert.fail(`unexpected error: ${message}`),
    info: () => { },
    command: () => { },
    choose: async (prompt) => {
      prompts.push(prompt);
      return "Later";
    },
    slow: (_, promise) => promise,
    progress: (_, __, body) => body(() => { }),
    localize: (message) => message,
    shouldReuse: async () => undefined,
    promptReload: async () => { },
    promptUpdate: async () => { },
  };

  try {
    const result = await prepare(ui, false);
    assert.equal(result.source, "configured");
    assert.equal(result.modelDir, configured, "the configured model is used");
    assert.equal(prompts.length, 0, "no download offer for a usable configured model");

    // An unusable path must not suppress the offer: the server cannot start
    // on it, and the extension reports that problem separately.
    ui.modelPath = join(configured, "missing");
    const fallback = await prepare(ui, false);
    assert.equal(fallback.modelDir, null);
    assert.equal(prompts.length, 1, "the offer returns when the configured path is unusable");
  } finally {
    await rm(storage, { recursive: true, force: true });
    await rm(configured, { recursive: true, force: true });
  }
});

test("the model is only considered installed when all three files exist", async () => {
  const storage = join(tmpdir(), `pali-test-model-${Date.now()}`);
  const dir = modelDir(storage);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "{\n}\n", "utf8");
    assert.equal(await resolveModelDir(storage), null, "partial install is not usable");

    await writeFile(join(dir, "tokenizer.json"), "{}\n", "utf8");
    await writeFile(join(dir, "model.safetensors"), "weights", "utf8");
    assert.equal(await resolveModelDir(storage), dir);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("an unusable pali.modelPath names what is missing", async () => {
  const root = join(tmpdir(), `pali-test-model-path-${Date.now()}`);
  const dir = join(root, "bge-small-en-v1.5");
  try {
    assert.match(
      await modelPathProblem(dir),
      /does not exist/,
      "a missing directory is reported",
    );

    const file = join(root, "not-a-dir");
    await mkdir(root, { recursive: true });
    await writeFile(file, "", "utf8");
    assert.match(await modelPathProblem(file), /not a directory/);

    await mkdir(dir, { recursive: true });
    const empty = await modelPathProblem(dir);
    for (const name of MODEL_FILES) {
      assert.ok(empty.includes(name), `${name} must be reported missing`);
    }

    await writeFile(join(dir, MODEL_FILES[0]), "{}\n", "utf8");
    await writeFile(join(dir, MODEL_FILES[1]), "{}\n", "utf8");
    const partial = await modelPathProblem(dir);
    assert.ok(!partial.includes(MODEL_FILES[0]), partial);
    assert.ok(partial.includes(MODEL_FILES[2]), partial);

    await writeFile(join(dir, MODEL_FILES[2]), "weights", "utf8");
    assert.equal(await modelPathProblem(dir), undefined, "all three files are usable");

    await writeFile(join(dir, MODEL_FILES[2]), "", "utf8");
    assert.ok(
      (await modelPathProblem(dir)).includes(MODEL_FILES[2]),
      "an empty file is not usable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LFS pointers parse, real model files do not", () => {
  const oid = "a".repeat(64);
  const pointer = parseLfsPointer(
    "version https://git-lfs.github.com/spec/v1\n" + `oid sha256:${oid}\n` + "size 133466304\n",
  );
  assert.deepEqual(pointer, { oid, size: 133466304 });
  assert.equal(parseLfsPointer('{"hidden_size": 384}'), null);
});

test("an installed model is exported to the server as PALI_MODEL_DIR", () => {
  const definition = mcpServerDefinition(
    { ...settings, modelDir: "/storage/models/bge-small-en-v1.5" },
    token,
  );
  assert.equal(definition.env.PALI_MODEL_DIR, "/storage/models/bge-small-en-v1.5");
});

test("pali.modelPath is exported as PALI_MODEL_DIR and wins over the installed model", () => {
  const configured = mcpServerDefinition(
    { ...settings, modelPath: "/custom/models/bge-small-en-v1.5" },
    token,
  );
  assert.equal(configured.env.PALI_MODEL_DIR, "/custom/models/bge-small-en-v1.5");

  const both = mcpServerDefinition(
    { ...settings, modelPath: "/custom/models", modelDir: "/storage/models/bge-small-en-v1.5" },
    token,
  );
  assert.equal(both.env.PALI_MODEL_DIR, "/custom/models");
});

test("hook commands carry the model directory for the hook-spawned server", () => {
  const entry = buildHookConfig(
    "/ext",
    { ...settings, modelPath: "/custom/models", modelDir: "/storage/models/bge-small-en-v1.5" },
  ).hooks.sessionStart[0];
  assert.match(entry.bash, /PALI_MODEL_DIR='\/custom\/models'/);
  assert.match(entry.powershell, /\$env:PALI_MODEL_DIR='\/custom\/models';/);

  // No modelPath: the installed model dir is used instead.
  const installed = buildHookConfig(
    "/ext",
    { ...settings, modelDir: "/storage/models/bge-small-en-v1.5" },
  ).hooks.sessionStart[0];
  assert.match(installed.bash, /PALI_MODEL_DIR='\/storage\/models\/bge-small-en-v1\.5'/);

  // Neither set: no variable, so the server falls back to its own resolution.
  const bare = buildHookConfig("/ext", settings).hooks.sessionStart[0];
  assert.doesNotMatch(bare.bash, /PALI_MODEL_DIR/);
  assert.doesNotMatch(bare.powershell, /PALI_MODEL_DIR/);
});

test("no token means no credential variable, even for HTTPS", () => {
  const https = mcpServerDefinition({ ...settings, remoteUrl: "https://example.com/mem.git" });
  assert.equal(https.env.PALI_GIT_TOKEN, undefined);
});

test("MCP definition omits empty optional settings", () => {
  const definition = mcpServerDefinition({
    ...settings,
    repoPath: "",
    remoteUrl: "",
    remoteSync: false,
  });

  assert.deepEqual(definition.env, { NO_COLOR: "1", PALI_BRANCH: "trunk" });
});

// --- Logging ---------------------------------------------------------------
//
// One `pali.logLevel` setting drives the extension logger, the MCP server
// (RUST_LOG), and the hooks (PALI_HOOK_LOG_LEVEL). These tests pin the level
// filtering and the filter mapping.

test("normalizeLogLevel falls back to info for unknown values", () => {
  assert.equal(normalizeLogLevel("debug"), "debug");
  assert.equal(normalizeLogLevel("INFO"), "info");
  assert.equal(normalizeLogLevel("off"), "off");
  assert.equal(normalizeLogLevel(undefined), "info");
  assert.equal(normalizeLogLevel("verbose"), "info");
});

test("rustLogFilter scopes the filter to the pali crate", () => {
  assert.equal(rustLogFilter("debug"), "pali=debug,info");
  assert.equal(rustLogFilter("info"), "pali=info,warn");
  assert.equal(rustLogFilter("warn"), "pali=warn");
  assert.equal(rustLogFilter("error"), "pali=error");
  assert.equal(rustLogFilter("off"), "off");
});

test("the logger filters below the configured level", () => {
  const lines = [];
  const originalSink = log.setSink((line) => lines.push(line));
  try {
    log.setLevel("warn");
    log.debug("hidden");
    log.info("hidden");
    log.warn("shown");
    log.error("shown");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /WARN.*shown/);
    assert.match(lines[1], /ERROR.*shown/);

    log.setLevel("off");
    log.error("hidden");
    assert.equal(lines.length, 2);

    log.setLevel("debug");
    log.debug("shown");
    assert.equal(lines.length, 3);
    assert.match(lines[2], /DEBUG.*shown/);
  } finally {
    // Restore the module defaults so other tests see a clean logger.
    log.setLevel("info");
    log.setSink(originalSink);
  }
});

// --- Release downloads -----------------------------------------------------
//
// The binary and the model both come from the project's GitHub Enterprise
// releases. These tests stub `fetch` with in-memory ZIP archives so the full
// download path (auth header, progress, extraction, cleanup) runs without
// network access.

/** Build a minimal stored (uncompressed) ZIP archive from name/data pairs. */
function zipArchive(entries) {
  const { crc32 } = require("node:zlib");
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** Build a gzip-compressed tar archive from name/data pairs (stored entries). */
function tarGzArchive(entries) {
  const { gzipSync } = require("node:zlib");
  const blocks = [];
  for (const { name, data } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write(
      Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0") + "\0",
      136,
      "ascii",
    );
    header.write("0000000\0", 148, "ascii");
    header.write("0", 156, "ascii"); // typeflag: regular file
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(blocks));
}

/** A UI double that records every callback the install library invokes. */
function makeInstallUi(storage, { token = "test-token", modelAnswer = "Later" } = {}) {
  const calls = { errors: [], infos: [], reloads: [], prompts: [], progress: [] };
  return {
    paliPath: "pali-nonexistent-xyz",
    storagePath: storage,
    extensionPath: join(tmpdir(), `pali-test-ext-${Date.now()}`),
    getToken: async () => token,
    error: (message) => calls.errors.push(message),
    info: (message) => calls.infos.push(message),
    command: () => { },
    choose: async (prompt) => {
      calls.prompts.push(prompt);
      return modelAnswer;
    },
    slow: (_, promise) => promise,
    progress: (_, __, body) => body((fraction) => calls.progress.push(fraction)),
    localize: (message) => message,
    shouldReuse: async () => undefined,
    promptReload: async (message) => calls.reloads.push(message),
    promptUpdate: async () => { },
    calls,
  };
}

test("installLatest downloads the release zip and extracts the binary", async () => {
  const storage = join(tmpdir(), `pali-test-dl-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const target = require("../out/utils/install_pali").getReleaseTarget(
    process.platform,
    process.arch,
  );
  assert.ok(target, "tests must run on a platform with a prebuilt binary");
  const binName = binaryName();
  const payload = Buffer.from("#!/bin/sh\necho pali 1.0.0\n");
  const zip = zipArchive([{ name: binName, data: payload }]);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(zip, {
      status: 200,
      headers: { "content-length": String(zip.length) },
    });
  };
  const ui = makeInstallUi(storage);
  try {
    await installLatest(ui);

    assert.equal(requests.length, 1, "one download for the binary, none for the model");
    assert.equal(
      requests[0].url,
      `https://github.com/cderivan/memory-mcp/releases/latest/download/${releaseAssetName(target)}`,
    );
    assert.equal(requests[0].headers.Authorization, "Bearer test-token");

    const installed = join(storage, binName);
    assert.deepEqual(await readFile(installed), payload);
    assert.equal(ui.paliPath, installed);
    assert.equal(
      await stat(join(storage, releaseAssetName(target))).then(
        () => "exists",
        () => "gone",
      ),
      "gone",
      "the archive is removed after extraction",
    );
    const maintenance = JSON.parse(await readFile(join(storage, "maintenance.json"), "utf8"));
    assert.equal(maintenance.checkUpdates, true);
    assert.ok(maintenance.installedVersion, "the version is recorded for update checks");
    assert.equal(ui.calls.reloads.length, 1, "the server restart is requested after install");
    assert.ok(ui.calls.progress.length > 0, "download progress is reported");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a 404 from the browser download URL retries through the release asset API", async () => {
  // Regression: `github.com/.../releases/download/...` answers 404 for a
  // private repository even with a valid token. The release asset API is the
  // only token-authenticated download path, so a 404 must retry there rather
  // than surfacing a failed install.
  const storage = join(tmpdir(), `pali-test-dl-api-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const target = require("../out/utils/install_pali").getReleaseTarget(
    process.platform,
    process.arch,
  );
  assert.ok(target, "tests must run on a platform with a prebuilt binary");
  const name = releaseAssetName(target);
  const payload = Buffer.from("#!/bin/sh\necho pali 1.0.0\n");
  const zip = zipArchive([{ name: binaryName(), data: payload }]);
  const browserUrl = `https://github.com/cderivan/memory-mcp/releases/latest/download/${name}`;
  const assetUrl = "https://api.github.com/repos/cderivan/memory-mcp/releases/assets/711664240";

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    requests.push({ url: href, headers: init?.headers ?? {} });
    if (href === browserUrl) {
      return new Response("Not Found", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/plain" },
      });
    }
    if (href === "https://api.github.com/repos/cderivan/memory-mcp/releases/latest") {
      return new Response(JSON.stringify({ tag_name: "0.0.1", assets: [{ name, url: assetUrl }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === assetUrl) {
      return new Response(zip, {
        status: 200,
        headers: { "content-length": String(zip.length) },
      });
    }
    return new Response("unexpected request", { status: 500 });
  };
  const ui = makeInstallUi(storage);
  try {
    await installLatest(ui);

    assert.deepEqual(
      requests.map((request) => request.url),
      [
        browserUrl,
        "https://api.github.com/repos/cderivan/memory-mcp/releases/latest",
        assetUrl,
      ],
      "the browser URL 404 is followed by the release lookup and the asset download",
    );
    assert.equal(requests[2].headers.Authorization, "Bearer test-token");
    assert.equal(
      requests[2].headers.Accept,
      "application/octet-stream",
      "the asset endpoint returns JSON without the octet-stream media type",
    );
    assert.deepEqual(await readFile(join(storage, binaryName())), payload);
    assert.equal(ui.calls.errors.length, 0, "the retry must not be reported as a failure");
    assert.equal(ui.calls.reloads.length, 1, "the server restart is requested after install");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("installLatest extracts the bare-triple binary from the macOS zip", async () => {
  // The macOS release archive holds a single universal executable named after
  // the target triple, not `pali` — extraction must still land it as the
  // platform binary name.
  const storage = join(tmpdir(), `pali-test-dl-mac-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const payload = Buffer.from("universal-binary-bytes");
  const zip = zipArchive([{ name: "aarch64-apple-darwin", data: payload }]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(zip, { status: 200, headers: { "content-length": String(zip.length) } });
  const ui = makeInstallUi(storage);
  try {
    await installLatest(ui);
    assert.deepEqual(await readFile(join(storage, binaryName())), payload);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("extractBinaryFromArchive reads the Linux tar.gz binary", async () => {
  const storage = join(tmpdir(), `pali-test-dl-tar-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const payload = Buffer.from("linux-binary-bytes");
  const tgz = tarGzArchive([{ name: "pali", data: payload }]);
  try {
    const dest = await extractBinaryFromArchive(tgz, storage, "x86_64-unknown-linux-gnu");
    assert.equal(dest, join(storage, binaryName()));
    assert.deepEqual(await readFile(dest), payload);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("a 401 during the binary download points at the token command", async () => {
  const storage = join(tmpdir(), `pali-test-dl-401-${Date.now()}`);
  await mkdir(storage, { recursive: true });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
  const ui = makeInstallUi(storage);
  try {
    await assert.rejects(
      () => installLatest(ui),
      /401[\s\S]*Set HTTPS Token/,
      "the error must steer the user to the token command",
    );
    assert.equal(
      await stat(join(storage, binaryName())).then(
        () => "exists",
        () => "gone",
      ),
      "gone",
      "no partial binary is left behind",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a failed download quotes a truncated body snippet in the error", async () => {
  // Regression: a bare status code hid which page the server served, so an SSO
  // interstitial and a permission-denied notice looked identical. The snippet
  // must name the page without buffering or echoing the whole error body.
  const storage = join(tmpdir(), `pali-test-dl-snippet-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const body =
    "<html><head><title>Insufficient permission</title></head><body>" +
    "x".repeat(5000) +
    "</body></html>";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(body, { status: 403, statusText: "Forbidden" });
  const ui = makeInstallUi(storage);
  try {
    await assert.rejects(
      () => installLatest(ui),
      (error) => {
        assert.match(error.message, /403[\s\S]*Set HTTPS Token/);
        assert.match(error.message, /Insufficient permission/, "the page title is reported");
        assert.doesNotMatch(
          error.message,
          /x{300}/,
          "the body is truncated rather than echoed in full",
        );
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a download retried after a failure still completes", async () => {
  // Regression guard: a code path that reads the response body twice leaves
  // the stream locked, so a retry after a failed attempt must still install.
  const storage = join(tmpdir(), `pali-test-dl-retry-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  assert.ok(
    getReleaseTarget(process.platform, process.arch),
    "tests must run on a platform with a prebuilt binary",
  );
  const payload = Buffer.from("retried-binary-bytes");
  const zip = zipArchive([{ name: binaryName(), data: payload }]);

  let attempt = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response("<html><body>temporarily unavailable</body></html>", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }
    return new Response(zip, {
      status: 200,
      headers: { "content-length": String(zip.length) },
    });
  };
  const ui = makeInstallUi(storage);
  try {
    await assert.rejects(() => installLatest(ui), /503/);
    assert.equal(
      await stat(join(storage, binaryName())).then(
        () => "exists",
        () => "gone",
      ),
      "gone",
      "a failed attempt leaves no binary behind",
    );

    await installLatest(ui);

    assert.equal(attempt, 2, "the retry downloads again rather than reusing the failed body");
    assert.deepEqual(await readFile(join(storage, binaryName())), payload);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a 200 login page is not saved as the binary", async () => {
  // Regression: GitHub Enterprise redirects unauthenticated downloads to the
  // SAML SSO page and answers 200 with HTML. The old code saved that page as
  // the binary, so the next activation found a "cached" binary that was really
  // a login page and never offered a re-download.
  const storage = join(tmpdir(), `pali-test-dl-login-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const html =
    '<!DOCTYPE html>\n<html lang="en">\n<head><title>Initiating SAML single sign-on</title></head>\n<body></body>\n</html>\n';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  const ui = makeInstallUi(storage);
  try {
    await assert.rejects(
      () => installLatest(ui),
      /login page[\s\S]*Set HTTPS Token/,
      "the error must name the login page and the token command",
    );
    assert.equal(
      await stat(join(storage, binaryName())).then(
        () => "exists",
        () => "gone",
      ),
      "gone",
      "the HTML page must never be written as the binary",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a cached binary that is an HTML login page counts as missing", async () => {
  // A failed download can leave the SSO page under the binary name. The
  // resolver must treat that as missing so the install offer reappears.
  const ctx = makeContext();
  const cached = join(ctx.globalStoragePath, binaryName());
  await mkdir(ctx.globalStoragePath, { recursive: true });
  await writeFile(cached, "<!DOCTYPE html>\n<html><head><title>SSO</title></head></html>", "utf8");
  chmodSync(cached, 0o755);
  try {
    const result = await require("../out/utils/lib").resolvePaliBinary(ctx, {
      binPath: "pali-nonexistent-xyz",
    });
    assert.equal(result.source, "missing");
    assert.equal(result.path, null);
  } finally {
    await rm(ctx.globalStoragePath, { recursive: true, force: true });
  }
});

test("a model dir whose files are HTML login pages is not installed", async () => {
  const storage = join(tmpdir(), `pali-test-model-login-${Date.now()}`);
  const dir = modelDir(storage);
  const html = "<!DOCTYPE html>\n<html><head><title>SSO</title></head></html>";
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), html, "utf8");
    await writeFile(join(dir, "tokenizer.json"), html, "utf8");
    await writeFile(join(dir, "model.safetensors"), html, "utf8");
    assert.equal(
      await resolveModelDir(storage),
      null,
      "HTML login pages must not count as an installed model",
    );
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("the installer reads the same model manifest as the crate", async () => {
  // The installer must not carry its own copy of the model layout: the Rust
  // loader embeds src/model-manifest.json, so a divergence would download files
  // into a directory the server never resolves.
  const manifest = JSON.parse(
    await readFile(join(__dirname, "..", "src", "model-manifest.json"), "utf8"),
  );

  assert.equal(modelDir("/storage"), join("/storage", "models", manifest.dir));
  assert.deepEqual(MODEL_FILES, [
    manifest.files.config,
    manifest.files.tokenizer,
    manifest.files.weights,
  ]);
  for (const name of MODEL_FILES) {
    assert.doesNotMatch(name, /[\\/]/, `${name} must be a bare file name`);
  }
});

test("installModel downloads and extracts the model zip", async () => {
  const storage = join(tmpdir(), `pali-test-model-dl-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  const zip = zipArchive([
    { name: "config.json", data: Buffer.from('{"hidden_size": 384}') },
    { name: "tokenizer.json", data: Buffer.from("{}") },
    { name: "model.safetensors", data: Buffer.from("weights") },
  ]);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(zip, {
      status: 200,
      headers: { "content-length": String(zip.length) },
    });
  };
  const ui = makeInstallUi(storage);
  try {
    const dir = await installModel(ui);

    assert.equal(dir, modelDir(storage));
    assert.equal(await resolveModelDir(storage), dir, "all three files are usable");
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://raw.githubusercontent.com/cderivan/memory-mcp/main/models/bge-small-en-v1.5.zip",
      "the raw host avoids the redirect that drops the Authorization header",
    );
    assert.equal(requests[0].headers.Authorization, "Bearer test-token");
    assert.equal(
      await stat(join(dir, "bge-small-en-v1.5.zip")).then(
        () => "exists",
        () => "gone",
      ),
      "gone",
      "the archive is removed after extraction",
    );
    assert.equal(ui.calls.errors.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

test("a failed model download reports the token hint and leaves no partial install", async () => {
  const storage = join(tmpdir(), `pali-test-model-dl-403-${Date.now()}`);
  await mkdir(storage, { recursive: true });

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ headers: init?.headers ?? {} });
    return new Response("Forbidden", { status: 403, statusText: "Forbidden" });
  };
  const ui = makeInstallUi(storage, { token: null });
  try {
    const dir = await installModel(ui);

    assert.equal(dir, null, "the install is reported as failed, not thrown");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.Authorization, undefined, "no token means no header");
    assert.equal(ui.calls.errors.length, 1);
    assert.match(ui.calls.errors[0], /403/);
    assert.match(ui.calls.errors[0], /Set HTTPS Token/);
    assert.equal(await resolveModelDir(storage), null, "no partial model counts as installed");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(storage, { recursive: true, force: true });
  }
});

// Regression: the provider used to publish a definition built from the
// configured `pali.path` even when nothing was executable there, so VS Code
// spawned a missing file and reported ENOENT instead of offering an install.
test("the MCP provider publishes nothing when no binary resolves", async () => {
  const storage = join(tmpdir(), `pali-test-provider-${Date.now()}`);
  const extensionRoot = join(tmpdir(), `pali-test-ext-provider-${Date.now()}`);
  await mkdir(storage, { recursive: true });
  await mkdir(join(extensionRoot, "skills", "pali-memory"), { recursive: true });
  await writeFile(
    join(extensionRoot, "skills", "pali-memory", "SKILL.md"),
    "name: pali-memory\n",
    "utf8",
  );
  await mkdir(join(extensionRoot, "instructions"), { recursive: true });
  await writeFile(
    join(extensionRoot, "instructions", "pali-memory.instructions.md"),
    await readFile(join(__dirname, "..", "instructions", "pali-memory.instructions.md"), "utf8"),
    "utf8",
  );

  // Activation writes the user-level hook config. Point it at the throwaway
  // extension root: without this, the test overwrites the real
  // ~/.copilot/hooks/pali.json with a path that is deleted afterwards, and
  // every later Copilot hook fails with MODULE_NOT_FOUND.
  const previousHooksDir = process.env.PALI_HOOKS_DIR;
  process.env.PALI_HOOKS_DIR = join(extensionRoot, "hooks");
  const previousSkillsDir = process.env.PALI_SKILLS_DIR;
  process.env.PALI_SKILLS_DIR = join(extensionRoot, "user-skills");
  const previousInstructions = process.env.PALI_INSTRUCTIONS_PATH;
  process.env.PALI_INSTRUCTIONS_PATH = join(
    extensionRoot,
    "user-instructions",
    "pali-memory.instructions.md",
  );

  const disposable = () => ({ dispose() { } });
  let provider;
  const fakeVscode = {
    EventEmitter: class {
      get event() {
        return () => disposable();
      }
      fire() { }
      dispose() { }
    },
    commands: { registerCommand: () => disposable(), executeCommand: async () => { } },
    env: { openExternal() { } },
    lm: {
      registerMcpServerDefinitionProvider: (_id, definitionProvider) => {
        provider = definitionProvider;
        return disposable();
      },
    },
    window: {
      ProgressLocation: { Notification: 1 },
      createOutputChannel: () => ({ appendLine() { }, dispose() { } }),
      showErrorMessage() { },
      showInformationMessage: async () => undefined,
      showInputBox: async () => undefined,
      showWarningMessage() { },
      withProgress: async (_options, task) =>
        task({ report() { } }, { onCancellationRequested() { } }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key) => (key === "path" ? "/nonexistent/pali-binary" : undefined),
        update: async () => { },
      }),
      onDidChangeConfiguration: () => disposable(),
      workspaceFolders: undefined,
    },
  };

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return fakeVscode;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    const extension = require("../out/extension");
    extension.activate({
      extensionPath: extensionRoot,
      globalStorageUri: { fsPath: storage },
      secrets: { delete: async () => { }, get: async () => undefined, store: async () => { } },
      subscriptions: [],
    });

    assert.ok(provider, "activate must register the MCP server definition provider");
    assert.deepEqual(await provider.provideMcpServerDefinitions(), []);
    assert.equal(
      await readFile(join(extensionRoot, "user-skills", "pali-memory", "SKILL.md"), "utf8"),
      "name: pali-memory\n",
      "activation must install the skill for the user",
    );
    const instructions = await readFile(
      join(extensionRoot, "user-instructions", "pali-memory.instructions.md"),
      "utf8",
    );
    assert.match(instructions, /^---\n/);
    assert.match(instructions, /^applyTo: '\*\*'$/m);
    assert.match(instructions, /`recall`/);
    assert.match(instructions, /`note`/);
  } finally {
    Module._load = originalLoad;
    if (previousHooksDir === undefined) delete process.env.PALI_HOOKS_DIR;
    else process.env.PALI_HOOKS_DIR = previousHooksDir;
    if (previousSkillsDir === undefined) delete process.env.PALI_SKILLS_DIR;
    else process.env.PALI_SKILLS_DIR = previousSkillsDir;
    if (previousInstructions === undefined) delete process.env.PALI_INSTRUCTIONS_PATH;
    else process.env.PALI_INSTRUCTIONS_PATH = previousInstructions;
    await rm(extensionRoot, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

// The hook file outlives the extension directory it points into, so uninstall
// has to remove it; otherwise every Copilot hook event fails with
// MODULE_NOT_FOUND until the user deletes it by hand.
test("uninstall removes the hook config this extension wrote", async () => {
  const { removeHookConfig } = require("../out/uninstall");
  const dir = join(tmpdir(), `pali-test-uninstall-${Date.now()}`);
  const target = join(dir, "pali.json");
  const exists = () => stat(target).then(() => true, () => false);
  await mkdir(dir, { recursive: true });
  try {
    assert.equal(removeHookConfig(dir), false, "a missing file is not an error");

    // Another tool's file at the same path must survive the uninstall.
    await writeFile(
      target,
      JSON.stringify({ version: 1, hooks: { agentStop: [{ bash: "node /x/other.mjs stop" }] } }),
      "utf8",
    );
    assert.equal(removeHookConfig(dir), false, "a foreign hook file is left alone");
    assert.equal(await exists(), true);

    await writeFile(
      target,
      JSON.stringify({
        version: 1,
        hooks: {
          agentStop: [
            {
              type: "command",
              bash: "PALI_BIN='pali' node '/ext/hooks/copilot-hooks.mjs' stop",
              powershell: "node '/ext/hooks/copilot-hooks.mjs' stop",
            },
          ],
        },
      }),
      "utf8",
    );
    assert.equal(removeHookConfig(dir), true);
    assert.equal(await exists(), false, "the Pali hook config is removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
