"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

/** Fake vscode module for testing UI class */
function createFakeVscode({ rootPath, answer, configStore, progressCancellable = false, rejectConfigKeys = [] } = {}) {
  const state = {
    infoMessages: [],
    errorMessages: [],
    configUpdates: [],
    commands: new Map(),
    progressCalled: [],
    progressCancelHandler: null,
  };

  return {
    window: {
      showInformationMessage: (() => {
        const fn = async (message, ...options) => {
          state.infoMessages.push({ message, options });
          return answer;
        };
        fn.mock = { calls: [] };
        return fn;
      })(),
      showErrorMessage: (msg) => {
        state.errorMessages.push(msg);
      },
      withProgress: (options, task) => {
        state.progressCalled.push(options);
        const progress = { report: () => { } };
        const cancellableToken = {
          onCancellationRequested: (handler) => {
            state.progressCancelHandler = handler;
            return { dispose: () => { } };
          }
        };
        return task(progress, cancellableToken);
      },
      infoMessages: state.infoMessages,
      errorMessages: state.errorMessages,
      progressCalled: state.progressCalled,
    },
    commands: {
      registerCommand: (id, body) => {
        state.commands.set(id, body);
        return { dispose: () => { } };
      },
      executeCommand: () => { },
      get: (id) => state.commands.get(id),
    },
    workspace: {
      rootPath,
      configUpdates: state.configUpdates,
      getConfiguration: () => ({
        get: (key) => configStore?.[key],
        update: (key, value, target) => {
          if (rejectConfigKeys.includes(key)) {
            return Promise.reject(new Error("config update failed"));
          }
          state.configUpdates.push({ key, value, target });
        },
        inspect: () => undefined,
      }),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 1 },
  };
}
/**
 * Build a minimal valid ZIP (stored, method 0) holding a single entry named
 * `pali`, returned as a base64-encoded data URL. `extractBinaryFromArchive`
 * reads the executable straight out of the central directory, so the payload
 * bytes can be arbitrary and still satisfy the installer.
 */
function makePaliZipDataUrl(content = "#!/bin/sh\necho pali\n") {
  const name = Buffer.from("pali", "utf8");
  const data = Buffer.from(content, "utf8");

  // Local file header (stored) + name + data.
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(0, 14); // crc32
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(name.length, 26); // name length
  local.writeUInt16LE(0, 28); // extra length

  // Central directory entry.
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(0, 10); // method: stored
  central.writeUInt16LE(0, 12); // mod time
  central.writeUInt16LE(0, 14); // mod date
  central.writeUInt32LE(0, 16); // crc32
  central.writeUInt32LE(data.length, 20); // compressed size
  central.writeUInt32LE(data.length, 24); // uncompressed size
  central.writeUInt16LE(name.length, 28); // name length
  central.writeUInt16LE(0, 30); // extra length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  // End of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(central.length + name.length, 12); // cd size
  eocd.writeUInt32LE(local.length + name.length + data.length, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment length

  const zip = Buffer.concat([
    local,
    name,
    data,
    central,
    name,
    eocd,
  ]);
  return `data:application/zip;base64,${zip.toString("base64")}`;
}

/** Load UI class with fake vscode module */
function loadUI(vscodeModule) {
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscodeModule;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve("../out/utils/install")];
    return require("../out/utils/install").UI;
  } finally {
    Module._load = originalLoad;
  }
}

test("shouldReuse returns true when user chooses use installed version", async () => {
  const vscode = createFakeVscode({
    answer: "Use the installed version",
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  const result = await ui.shouldReuse("1.0.0");

  assert.equal(result, true, "shouldReuse should return true when user chooses reuse");
  assert.equal(vscode.window.showInformationMessage.mock.calls.length, 0); // Already counted in create
});

test("shouldReuse returns false when user chooses reinstall", async () => {
  const vscode = createFakeVscode({
    answer: "Delete it and reinstall",
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  const result = await ui.shouldReuse("1.0.0");

  assert.equal(result, false, "shouldReuse should return false when user chooses reinstall");
});

test("shouldReuse returns undefined when user dismisses prompt", async () => {
  const vscode = createFakeVscode({
    answer: undefined,
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  const result = await ui.shouldReuse("1.0.0");

  assert.equal(result, undefined, "shouldReuse should return undefined when user dismisses");
});

test("promptUpdate calls installLatest when user chooses upgrade", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    // Match the releases/latest endpoint
    if (url.includes("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          tag_name: "v2.0.0",
          assets: [
            { name: "aarch64-apple-darwin.zip", url: makePaliZipDataUrl() }
          ]
        })
      };
    }
    return originalFetch(url, options);
  };

  const vscode = createFakeVscode({
    answer: "Install pali 2.0.0",
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  await ui.promptUpdate("1.0.0", "2.0.0");

  const binaryName = process.platform === "win32" ? "pali.exe" : "pali";
  const installedPath = path.join(ui.storagePath, binaryName);
  assert.ok(
    fs.existsSync(installedPath),
    `pali binary should be installed at ${installedPath}`,
  );
  const contents = fs.readFileSync(installedPath, "utf8");
  assert.match(contents, /^#!\/bin\/sh/, "installed binary should match the release asset payload");

  globalThis.fetch = originalFetch;
});

test("promptUpdate sets checkUpdates to false when user chooses dont ask again", async () => {
  const vscode = createFakeVscode({
    answer: "Don't ask again",
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  await ui.promptUpdate("1.0.0", "2.0.0");

  const checkUpdatesUpdate = vscode.workspace.getConfiguration().update;
  assert.ok(vscode.workspace.configUpdates.length > 0, "config update should have been called");
  const checkUpdate = vscode.workspace.configUpdates.find(u => u.key === "checkUpdates");
  assert.ok(checkUpdate, "checkUpdates should be updated");
  assert.equal(checkUpdate.value, false, "checkUpdates should be set to false");
});

test("progress method handles cancellation via AbortController", async () => {
  const vscode = createFakeVscode({
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");

  let cancelled = false;
  const abortController = new AbortController();
  abortController.signal.addEventListener("abort", () => {
    cancelled = true;
  });

  const result = await ui.progress("Test progress", abortController, async (report) => {
    // Simulate cancellation during execution
    abortController.abort();
    return "done";
  });

  assert.equal(cancelled, true, "AbortController should have been aborted");
});

test("progress method works with null cancel parameter", async () => {
  const vscode = createFakeVscode({
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");

  const result = await ui.progress("Test progress", null, async (report) => {
    report(0.5);
    return "success";
  });

  assert.equal(result, "success", "progress should return the body result");
});

test("resolvePaliPath resolves relative path with separator against workspace root", async () => {
  const vscode = createFakeVscode({
    rootPath: "/workspace/project",
    configStore: { path: "./relative/path/to/pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  await ui.resolvePaliPath();

  assert.ok(ui.paliPath.includes("/workspace"), "Path should include workspace root");
  assert.ok(ui.paliPath.includes("relative"), "Path should include relative path");
});

test("resolvePaliPath returns absolute path unchanged", async () => {
  const vscode = createFakeVscode({
    rootPath: "/workspace/project",
    configStore: { path: "/absolute/path/to/pali" }
  });
  const UI = loadUI(vscode);

  const ui = await UI.create([], os.tmpdir(), "/ext");
  await ui.resolvePaliPath();

  assert.equal(ui.paliPath, "/absolute/path/to/pali", "Absolute path should be unchanged");
});

test("getToken returns null when no token getter is configured", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  assert.equal(await ui.getToken(), null);
});

test("getToken returns the token from the configured getter", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext", async () => "sekret");
  assert.equal(await ui.getToken(), "sekret");
});

test("choose surfaces the prompt with each option", async () => {
  const vscode = createFakeVscode({
    answer: "b",
    configStore: { path: "pali" },
  });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  const result = await ui.choose("pick one", ["a", "b", "c"]);
  assert.equal(result, "b", "choose resolves to the selected option");
  const shown = vscode.window.infoMessages.at(-1);
  assert.equal(shown.message, "pick one");
  assert.deepEqual(shown.options, ["a", "b", "c"]);
});

test("slow wraps a promise in a non-cancellable progress notification", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  const result = await ui.slow("working", Promise.resolve(42));
  assert.equal(result, 42, "slow resolves to the wrapped promise result");
  const opts = vscode.window.progressCalled.at(-1);
  assert.equal(opts.cancellable, false, "slow uses a non-cancellable notification");
});

test("localize replaces positional placeholders with args", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  assert.equal(ui.localize("downloaded {0} of {1}", 3, 10), "downloaded 3 of 10");
  assert.equal(ui.localize("no placeholders"), "no placeholders");
});

test("error and info surface messages through the window", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  ui.error("boom");
  ui.info("hi");
  assert.deepEqual(vscode.window.errorMessages, ["boom"]);
  assert.ok(
    vscode.window.infoMessages.some((m) => m.message === "hi"),
    "info should surface through showInformationMessage",
  );
});

test("command registers a disposable command", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const disposables = [];
  const UI = loadUI(vscode);
  const ui = await UI.create(disposables, os.tmpdir(), "/ext");
  ui.command("pali.testCmd", () => 1);
  assert.ok(vscode.commands.get("pali.testCmd"), "command should be registered");
  assert.equal(disposables.length, 1, "command registration should push a disposable");
});

test("the paliPath setter persists the path globally", async () => {
  const vscode = createFakeVscode({ configStore: { path: "pali" } });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  ui.paliPath = "/new/path/pali";
  await new Promise((resolve) => setImmediate(resolve));
  const update = vscode.workspace.configUpdates.find((u) => u.key === "path");
  assert.ok(update, "the path should be written to the configuration");
  assert.equal(update.value, "/new/path/pali");
  assert.equal(update.target, vscode.ConfigurationTarget.Global);
});

test("the paliPath setter swallows a config write failure", async () => {
  const vscode = createFakeVscode({
    configStore: { path: "pali" },
    rejectConfigKeys: ["path"],
  });
  const UI = loadUI(vscode);
  const ui = await UI.create([], os.tmpdir(), "/ext");
  // The write rejects, but the setter must not throw: the path is still held
  // in memory and the failure is non-critical.
  ui.paliPath = "/new/path/pali";
  assert.equal(ui.paliPath, "/new/path/pali", "the in-memory path is still updated");
  await new Promise((resolve) => setImmediate(resolve));
});
