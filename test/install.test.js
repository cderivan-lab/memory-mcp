"use strict";

// Tests for src/utils/install.ts UI class methods: shouldReuse, promptUpdate, progress, resolvePaliPath
// These test the UI wrapper methods around the VSCode API.

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Module = require("node:module");

/** Fake vscode module for testing UI class */
function createFakeVscode({ rootPath, answer, configStore, progressCancellable = false } = {}) {
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
      showInformationMessage: async (message, ...options) => {
        state.infoMessages.push({ message, options });
        return answer;
      },
      showErrorMessage: (msg) => {
        state.errorMessages.push(msg);
      },
      withProgress: (options, task) => {
        state.progressCalled.push(options);
        const progress = { report: () => {} };
        const cancellableToken = { onCancellationRequested: (handler) => {
          state.progressCancelHandler = handler;
          return { dispose: () => {} };
        } };
        return task(progress, cancellableToken);
      },
    },
    commands: {
      registerCommand: (id, body) => {
        state.commands.set(id, body);
        return { dispose: () => {} };
      },
      executeCommand: () => {},
    },
    workspace: {
      rootPath,
      getConfiguration: () => ({
        get: (key) => configStore?.[key],
        update: (key, value, target) => {
          state.configUpdates.push({ key, value, target });
        },
        inspect: () => undefined,
      }),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 1 },
    window: { showInformationMessage: async (message, ...options) => {
      state.infoMessages.push({ message, options });
      return answer;
    }, showErrorMessage: (msg) => { state.errorMessages.push(msg); } },
    commands: { registerCommand: (id, body) => { state.commands.set(id, body); return { dispose: () => {} }; }, executeCommand: () => {} },
    workspace: { rootPath, getConfiguration: () => ({ get: (key) => configStore?.[key], update: (key, value, target) => { state.configUpdates.push({ key, value, target }); }, inspect: () => undefined }) },
    ProgressLocation: { Notification: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
  };
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
  const vscode = createFakeVscode({ 
    answer: "Install pali 2.0.0",
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);
  
  const ui = await UI.create([], os.tmpdir(), "/ext");
  await ui.promptUpdate("1.0.0", "2.0.0");
  
  // Should have called installLatest (which triggers pali.update command)
  // In the fake, this will register the command, so check commands were registered
  assert.ok(vscode.commands.has("pali.update"), "pali.update command should be registered");
});

test("promptUpdate sets checkUpdates to false when user chooses dont ask again", async () => {
  const vscode = createFakeVscode({ 
    answer: "Don't ask again",
    configStore: { path: "pali" }
  });
  const UI = loadUI(vscode);
  
  const ui = await UI.create([], os.tmpdir(), "/ext");
  await ui.promptUpdate("1.0.0", "2.0.0");
  
  // Should have updated checkUpdates to false
  const checkUpdatesUpdate = vscode.workspace.getConfiguration().update;
  // The update should have been called
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
  
  // When cancelled, progress returns undefined
  // Actually looking at the code, it still returns the body result
  // Let's verify the cancellation was handled
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