"use strict";

// End-to-end: this suite runs inside a real VS Code extension host, activates
// the extension, and asserts the file it writes for different `pali.*`
// profiles. The Copilot hook config is the observable output of the same
// settings bucket the MCP server definition is built from, so a profile that
// changes a setting must show up there without a reload.
//
// @vscode/test-cli installs mocha's globals before loading this file. Requiring
// `mocha` here would instantiate a second copy whose suites the runner never
// executes, so the globals are read off `globalThis` instead.
const { suite, test, suiteSetup, suiteTeardown } = globalThis;

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

// The model layout the server resolves; the installer and the crate share it.
const { files: MODEL_FILES } = require("../../src/model-manifest.json");

const EXTENSION_ID = "cderivan.pali-memory";
const SECTION = "pali";

/** Hook event -> the mode argument copilot-hooks.mjs is invoked with. */
const EVENT_MODES = {
  agentStop: "stop",
  sessionStart: "session-start",
  userPromptTransformed: "prompt",
};

const COMMANDS = [
  "pali.clearToken",
  "pali.index",
  "pali.install",
  "pali.restart",
  "pali.scan",
  "pali.scanRepositories",
  "pali.setToken",
  "pali.update",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What `bashQuote` in src/utils/lib.ts substitutes for a single quote: close
 * the quote, escape one, reopen. `String.raw` keeps it to exactly one
 * backslash, so the expectation cannot drift by miscounting escapes.
 */
const BASH_QUOTE_ESCAPE = String.raw`'\''`;

function bashQuote(value) {
  return `'${String(value).replace(/'/g, BASH_QUOTE_ESCAPE)}'`;
}

/**
 * A stand-in executable for `pali.path`. Activation resolves it and starts no
 * download, so the suite exercises settings without touching the network.
 */
function createStubBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pali-e2e-bin-"));
  const file = path.join(dir, process.platform === "win32" ? "pali.exe" : "pali");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(folders && folders.length, "the e2e host must open a workspace folder");
  return folders[0].uri.fsPath;
}

/** The user-level hooks file; the e2e env redirects it away from the real home. */
function hookConfigPath() {
  const dir = process.env.PALI_HOOKS_DIR;
  assert.ok(dir, "the e2e config must set PALI_HOOKS_DIR");
  return path.join(dir, "pali.json");
}

/** Apply one settings profile at workspace scope, one key at a time. */
async function applyProfile(profile) {
  const config = vscode.workspace.getConfiguration(SECTION);
  for (const [key, value] of Object.entries(profile)) {
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
}

/**
 * Poll until the hook file satisfies `predicate`. The extension rewrites it
 * from an async configuration listener, so the write is never synchronous with
 * `config.update`; a bounded poll keeps the assertion from racing it.
 */
async function waitForHookConfig(predicate, timeoutMs = 20_000) {
  const target = hookConfigPath();
  const deadline = Date.now() + timeoutMs;
  let last = "not written yet";
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (predicate(parsed)) return parsed;
      last = JSON.stringify(parsed);
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`hook config never matched (${target}); last: ${last}`);
}

suite("pali extension end-to-end", () => {
  let stub;
  let root;

  suiteSetup(async () => {
    stub = createStubBinary();
    root = workspaceRoot();

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();

    // Activation registers the commands and kicks off binary resolution
    // without awaiting it; wait for the command surface before asserting.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const commands = await vscode.commands.getCommands(true);
      if (COMMANDS.every((id) => commands.includes(id))) break;
      assert.ok(Date.now() < deadline, "the extension never registered its commands");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await applyProfile({ path: stub.file, checkUpdates: false });
  });

  suiteTeardown(() => {
    fs.rmSync(stub.dir, { recursive: true, force: true });
  });

  test("a fully configured profile reaches every hook event", async () => {
    await applyProfile({
      repoPath: "/tmp/pali e2e repo",
      scope: "org/team",
      branch: "trunk",
      remoteUrl: "https://example.com/mem.git",
      logLevel: "debug",
    });

    // Wait for every variable this test asserts: settings are applied one key
    // at a time, so matching on `scope` alone can observe a half-applied
    // profile (the log level lands later in the same loop).
    const config = await waitForHookConfig((parsed) => {
      const bash = String(parsed.hooks?.sessionStart?.[0]?.bash);
      return (
        bash.includes(`PALI_BIN='${stub.file}'`) &&
        bash.includes("PALI_REPO_PATH='/tmp/pali e2e repo'") &&
        bash.includes("PALI_SCOPE='org/team'") &&
        bash.includes("PALI_HOOK_LOG_LEVEL='debug'")
      );
    });

    assert.equal(config.version, 1);
    assert.deepEqual(Object.keys(config.hooks).sort(), Object.keys(EVENT_MODES).sort());
    assert.equal(
      fs.existsSync(path.join(root, ".github", "hooks", "pali.json")),
      false,
      "activation must install hooks once at the user level, not in the workspace",
    );

    for (const [event, mode] of Object.entries(EVENT_MODES)) {
      assert.equal(config.hooks[event].length, 1, `${event} must have one command`);
      const [entry] = config.hooks[event];
      assert.equal(entry.type, "command", event);
      assert.ok(entry.timeoutSec >= 30, event);

      // Both shells run the same script for the same event. The script path is
      // quoted, so the closing quote sits between the script and the mode.
      assert.match(entry.bash, new RegExp(`copilot-hooks\\.mjs' ${mode}$`), event);
      assert.match(entry.powershell, new RegExp(`copilot-hooks\\.mjs' ${mode}$`), event);

      assert.match(entry.bash, new RegExp(`PALI_BIN='${escapeRegExp(stub.file)}'`), event);
      assert.match(entry.bash, /PALI_REPO_PATH='\/tmp\/pali e2e repo'/, event);
      assert.match(entry.bash, /PALI_SCOPE='org\/team'/, event);
      assert.match(entry.bash, /PALI_HOOK_LOG_LEVEL='debug'/, event);
      assert.match(entry.powershell, /PALI_SCOPE='org\/team'/, event);

      // The remote and branch belong to the server, not the hook environment:
      // the token's exposure must not widen by being written to a repo file.
      assert.doesNotMatch(entry.bash, /PALI_REMOTE_URL|PALI_BRANCH/, event);
    }
  });

  test("pali.remoteSync reaches the MCP server definition", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "the extension under test must be installed");
    assert.ok(
      extension.packageJSON.contributes?.configuration?.properties?.["pali.remoteSync"],
      "pali.remoteSync must be a contributed setting",
    );
    assert.equal(
      extension.packageJSON.contributes.configuration.properties["pali.remoteSync"].default,
      false,
      "pali.remoteSync must default to false",
    );

    await applyProfile({
      remoteUrl: "https://example.com/mem.git",
      remoteSync: true,
    });

    // The editor has no read-back for a registered provider's definitions, so
    // run the definition builder `activate` uses with the setting the editor
    // actually returned, mirroring the modelPath test.
    const { mcpServerDefinition } = require(
      path.join(extension.extensionPath, "out", "utils", "lib"),
    );
    const config = vscode.workspace.getConfiguration(SECTION);
    const definition = mcpServerDefinition(
      {
        binPath: String(config.get("path") || "pali"),
        repoPath: String(config.get("repoPath") || "").trim(),
        remoteUrl: String(config.get("remoteUrl") || "").trim(),
        remoteSync: config.get("remoteSync") ?? false,
        branch: String(config.get("branch") || "main").trim() || "main",
        scope: String(config.get("scope") || "").trim(),
      },
      undefined,
    );

    assert.equal(
      config.get("remoteSync"),
      true,
      "pali.remoteSync must round-trip through the editor's configuration",
    );
    assert.equal(
      definition.env.PALI_REQUIRE_REMOTE_SYNC,
      "1",
      "the MCP server definition must launch with PALI_REQUIRE_REMOTE_SYNC when enabled",
    );

    await applyProfile({ remoteSync: false });
    const off = mcpServerDefinition(
      {
        binPath: String(config.get("path") || "pali"),
        repoPath: String(config.get("repoPath") || "").trim(),
        remoteUrl: String(config.get("remoteUrl") || "").trim(),
        remoteSync: config.get("remoteSync") ?? false,
        branch: String(config.get("branch") || "main").trim() || "main",
        scope: String(config.get("scope") || "").trim(),
      },
      undefined,
    );
    assert.equal(
      off.env.PALI_REQUIRE_REMOTE_SYNC,
      undefined,
      "the MCP server definition must not launch with PALI_REQUIRE_REMOTE_SYNC when disabled",
    );
  });

  test("a local-only profile omits the optional hook variables", async () => {
    await applyProfile({
      repoPath: "",
      scope: "",
      branch: "main",
      remoteUrl: "",
      logLevel: "info",
    });

    const config = await waitForHookConfig(
      (parsed) => {
        const bash = String(parsed.hooks?.agentStop?.[0]?.bash);
        return (
          bash.includes("PALI_HOOK_LOG_LEVEL='info'") &&
          !bash.includes("PALI_SCOPE") &&
          !bash.includes("PALI_REPO_PATH")
        );
      },
    );

    const bash = config.hooks.agentStop[0].bash;
    assert.match(bash, new RegExp(`PALI_BIN='${escapeRegExp(stub.file)}'`));
    assert.doesNotMatch(bash, /PALI_REPO_PATH|PALI_SCOPE/, "empty settings must not be exported");
    assert.doesNotMatch(config.hooks.agentStop[0].powershell, /PALI_REPO_PATH|PALI_SCOPE/);
  });

  test("settings containing quotes are escaped per shell", async () => {
    await applyProfile({ scope: "team's", repoPath: "/tmp/team's repo", logLevel: "warn" });

    const quotedScope = `PALI_SCOPE=${bashQuote("team's")}`;
    const config = await waitForHookConfig((parsed) =>
      String(parsed.hooks?.userPromptTransformed?.[0]?.bash).includes(quotedScope),
    );

    const [entry] = config.hooks.userPromptTransformed;
    // Bash closes the quote, escapes one, reopens; PowerShell doubles it.
    assert.ok(entry.bash.includes(quotedScope), entry.bash);
    assert.ok(entry.powershell.includes(`PALI_SCOPE='team''s'`), entry.powershell);
    assert.ok(entry.powershell.includes(`PALI_REPO_PATH='/tmp/team''s repo'`), entry.powershell);
  });

  test("changing a setting rewrites the hook config without a reload", async () => {
    const staleScope = `PALI_SCOPE=${bashQuote("team's")}`;
    // Parse rather than compare the raw text: the file is JSON, so its
    // backslashes are escaped on disk and only the parsed value is the shell
    // string the hook would actually run.
    const before = JSON.parse(fs.readFileSync(hookConfigPath(), "utf8"));
    assert.ok(String(before.hooks.agentStop[0].bash).includes(staleScope), before);

    await applyProfile({ scope: "other/team" });

    const after = await waitForHookConfig((parsed) =>
      String(parsed.hooks?.agentStop?.[0]?.bash).includes("PALI_SCOPE='other/team'"),
    );
    assert.equal(after.version, 1);
    const written = JSON.parse(fs.readFileSync(hookConfigPath(), "utf8"));
    assert.ok(
      !String(written.hooks.agentStop[0].bash).includes(staleScope),
      "the stale profile must be gone, not appended",
    );
  });

  test("pali.modelPath reaches the hooks and the MCP server definition", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "the extension under test must be installed");
    assert.ok(
      extension.packageJSON.contributes?.configuration?.properties?.["pali.modelPath"],
      "pali.modelPath must be a contributed setting",
    );

    // Spaces in the path keep the per-shell quoting honest. The directory has
    // to be usable, or activation withholds it (see the next test).
    const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pali-e2e-model-"));
    const modelPath = path.join(modelRoot, "pali e2e models", "bge-small-en-v1.5");
    fs.mkdirSync(modelPath, { recursive: true });
    for (const name of Object.values(MODEL_FILES)) {
      fs.writeFileSync(path.join(modelPath, name), "model file\n", "utf8");
    }

    try {
      await applyProfile({ modelPath });

      // The hook file is written by the extension's own settings read, so this
      // also proves activation exports `pali.modelPath` to every hook event.
      const quotedModel = `PALI_MODEL_DIR=${bashQuote(modelPath)}`;
      const hooks = await waitForHookConfig((parsed) =>
        Object.keys(EVENT_MODES).every((event) =>
          String(parsed.hooks?.[event]?.[0]?.bash).includes(quotedModel),
        ),
      );

      for (const [event, mode] of Object.entries(EVENT_MODES)) {
        const [entry] = hooks.hooks[event];
        assert.ok(entry.bash.includes(quotedModel), `${event}: ${entry.bash}`);
        assert.ok(
          entry.powershell.includes(`PALI_MODEL_DIR='${modelPath.replace(/'/g, "''")}'`),
          `${event}: ${entry.powershell}`,
        );
        assert.match(entry.bash, new RegExp(`copilot-hooks\\.mjs' ${mode}$`), event);
      }

      // The editor has no read-back for a registered provider's definitions, so
      // run the definition builder `activate` uses with the setting the editor
      // actually returned. The hook assertion above proves the extension's own
      // settings read; this pins modelPath -> PALI_MODEL_DIR in the definition.
      const { mcpServerDefinition } = require(
        path.join(extension.extensionPath, "out", "utils", "lib"),
      );
      const config = vscode.workspace.getConfiguration(SECTION);
      const definition = mcpServerDefinition(
        {
          binPath: String(config.get("path") || "pali"),
          repoPath: String(config.get("repoPath") || "").trim(),
          remoteUrl: String(config.get("remoteUrl") || "").trim(),
          remoteSync: config.get("remoteSync") ?? false,
          branch: String(config.get("branch") || "main").trim() || "main",
          scope: String(config.get("scope") || "").trim(),
          modelPath: String(config.get("modelPath") || "").trim(),
        },
        undefined,
      );

      assert.equal(
        config.get("modelPath"),
        modelPath,
        "pali.modelPath must round-trip through the editor's configuration",
      );
      assert.equal(
        definition.env.PALI_MODEL_DIR,
        modelPath,
        "the MCP server definition must launch with the configured model directory",
      );
    } finally {
      await applyProfile({ modelPath: "" });
      fs.rmSync(modelRoot, { recursive: true, force: true });
    }
  });

  test("an unusable pali.modelPath is withheld instead of failing the server", async () => {
    // Start from a usable value so the rewrite below is observable: after the
    // bad directory is set, neither path may remain in the hook commands.
    const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pali-e2e-model-bad-"));
    const validPath = path.join(modelRoot, "valid", "bge-small-en-v1.5");
    fs.mkdirSync(validPath, { recursive: true });
    for (const name of Object.values(MODEL_FILES)) {
      fs.writeFileSync(path.join(validPath, name), "model file\n", "utf8");
    }
    const invalidPath = path.join(modelRoot, "invalid", "bge-small-en-v1.5");
    fs.mkdirSync(invalidPath, { recursive: true });
    fs.writeFileSync(path.join(invalidPath, MODEL_FILES.config), "{}\n", "utf8");

    try {
      await applyProfile({ modelPath: validPath });
      await waitForHookConfig((parsed) =>
        Object.keys(EVENT_MODES).every((event) =>
          String(parsed.hooks?.[event]?.[0]?.bash).includes(
            `PALI_MODEL_DIR=${bashQuote(validPath)}`,
          ),
        ),
      );

      await applyProfile({ modelPath: invalidPath });
      const hooks = await waitForHookConfig((parsed) =>
        Object.keys(EVENT_MODES).every((event) => {
          const bash = String(parsed.hooks?.[event]?.[0]?.bash);
          return !bash.includes(validPath) && !bash.includes(invalidPath);
        }),
      );

      for (const [event, mode] of Object.entries(EVENT_MODES)) {
        const [entry] = hooks.hooks[event];
        assert.ok(!entry.bash.includes(invalidPath), `${event}: ${entry.bash}`);
        assert.ok(!entry.powershell.includes(invalidPath), `${event}: ${entry.powershell}`);
        assert.match(entry.bash, new RegExp(`copilot-hooks\\.mjs' ${mode}$`), event);
      }
    } finally {
      await applyProfile({ modelPath: "" });
      fs.rmSync(modelRoot, { recursive: true, force: true });
    }
  });

  test("uninstall removes the hook file and the extension writes it again", async () => {
    // The host loads the extension in development mode, which cannot be
    // uninstalled from inside itself. Run the exact script the manifest's
    // `vscode:uninstall` hook invokes, against the same redirected
    // PALI_HOOKS_DIR the host uses: that is the file lifecycle a real
    // uninstall produces.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "the extension under test must be installed");
    const target = hookConfigPath();
    assert.ok(fs.existsSync(target), "activation must have written the hook file");

    execFileSync(
      process.execPath,
      [path.join(extension.extensionPath, "out", "uninstall.js")],
      { cwd: extension.extensionPath, env: { ...process.env }, stdio: "pipe" },
    );
    assert.equal(fs.existsSync(target), false, "uninstall must delete the hook file");

    // A reinstall writes it again. The settings listener runs the same
    // installHooks() that activation uses, so this observes the rewrite the
    // reinstalled extension performs.
    await applyProfile({ scope: "reinstalled" });
    const config = await waitForHookConfig((parsed) =>
      String(parsed.hooks?.sessionStart?.[0]?.bash).includes("PALI_SCOPE='reinstalled'"),
    );
    assert.equal(config.version, 1);
    assert.ok(fs.existsSync(target), "the hook file must come back");

    // The rewritten command is guarded, so a later uninstall that misses the
    // file cannot crash the hook host with MODULE_NOT_FOUND.
    assert.match(
      config.hooks.sessionStart[0].bash,
      /^\[ -f '[^']*copilot-hooks\.mjs' \] \|\| exit 0; /,
    );
  });
});
