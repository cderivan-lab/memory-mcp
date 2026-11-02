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
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

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
  "pali.install",
  "pali.restart",
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

function hookConfigPath(root) {
  return path.join(root, ".github", "hooks", "pali.json");
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
async function waitForHookConfig(root, predicate, timeoutMs = 20_000) {
  const target = hookConfigPath(root);
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
    const config = await waitForHookConfig(root, (parsed) => {
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

  test("a local-only profile omits the optional hook variables", async () => {
    await applyProfile({
      repoPath: "",
      scope: "",
      branch: "main",
      remoteUrl: "",
      logLevel: "info",
    });

    const config = await waitForHookConfig(
      root,
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
    const config = await waitForHookConfig(root, (parsed) =>
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
    const before = JSON.parse(fs.readFileSync(hookConfigPath(root), "utf8"));
    assert.ok(String(before.hooks.agentStop[0].bash).includes(staleScope), before);

    await applyProfile({ scope: "other/team" });

    const after = await waitForHookConfig(root, (parsed) =>
      String(parsed.hooks?.agentStop?.[0]?.bash).includes("PALI_SCOPE='other/team'"),
    );
    assert.equal(after.version, 1);
    const written = JSON.parse(fs.readFileSync(hookConfigPath(root), "utf8"));
    assert.ok(
      !String(written.hooks.agentStop[0].bash).includes(staleScope),
      "the stale profile must be gone, not appended",
    );
  });
});
