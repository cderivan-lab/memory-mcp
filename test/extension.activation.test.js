"use strict";

// Activation-level tests: `out/extension` is loaded against a fake `vscode`
// module so the wiring itself is exercised — command registration, the MCP
// provider, the hook config rewrite on settings changes, the token commands,
// and the workspace bootstrap subcommands. The pure helpers are covered in
// extension.test.js; these tests pin the seams between them.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const { binaryName, bundledBinaryPath } = require("../out/utils/install_pali");
const pkg = require("../package.json");

const shippedInstructions = fs.readFileSync(
  path.join(__dirname, "..", "instructions", "pali-memory.instructions.md"),
  "utf8",
);

const CONTRIBUTED_COMMANDS = (pkg.contributes?.commands ?? []).map((entry) => entry.command);

function disposable() {
  return { dispose() { } };
}

/** A `pali.*` configuration backed by a plain object the test can mutate. */
function makeConfiguration(initial) {
  const store = { ...initial };
  const updates = [];
  return {
    store,
    updates,
    config: {
      get: (key) => store[key],
      async update(key, value) {
        store[key] = value;
        updates.push([key, value]);
      },
      inspect: () => undefined,
    },
  };
}

/** Fake `vscode` module recording everything activation tries to do. */
function makeVscode({ settings, workspaceFolders, rootPath }) {
  const state = {
    commands: new Map(),
    configListeners: [],
    output: [],
    infos: [],
    errors: [],
    warnings: [],
    progressTitles: [],
    secrets: new Map(),
    provider: null,
    providerId: undefined,
    providerChanges: 0,
    answer: "Later",
    input: undefined,
    executed: [],
  };

  class EventEmitter {
    constructor() {
      this.listeners = [];
    }
    get event() {
      return (listener) => {
        this.listeners.push(listener);
        return disposable();
      };
    }
    fire(value) {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose() { }
  }

  class McpStdioServerDefinition {
    constructor(label, command, args, env) {
      Object.assign(this, { label, command, args, env });
    }
  }

  const vscode = {
    EventEmitter,
    McpStdioServerDefinition,
    ProgressLocation: { Notification: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand(id, body) {
        state.commands.set(id, body);
        return disposable();
      },
      async executeCommand(id, ...args) {
        state.executed.push(id);
        const body = state.commands.get(id);
        return body ? body(...args) : undefined;
      },
    },
    window: {
      createOutputChannel() {
        return {
          appendLine: (line) => state.output.push(String(line)),
          append: (chunk) => state.output.push(String(chunk)),
          show() { },
          dispose() { },
        };
      },
      async showInformationMessage(message) {
        state.infos.push(String(message));
        return state.answer;
      },
      async showWarningMessage(message) {
        state.warnings.push(String(message));
        return undefined;
      },
      async showErrorMessage(message) {
        state.errors.push(String(message));
        return undefined;
      },
      async showInputBox() {
        return state.input;
      },
      async withProgress(options, task) {
        state.progressTitles.push(options.title);
        return task({ report() { } }, { onCancellationRequested: () => disposable() });
      },
    },
    workspace: {
      rootPath,
      workspaceFolders,
      getConfiguration: () => settings.config,
      onDidChangeConfiguration(listener) {
        state.configListeners.push(listener);
        return disposable();
      },
    },
    env: { openExternal() { } },
    lm: {
      registerMcpServerDefinitionProvider(id, provider) {
        state.providerId = id;
        state.provider = provider;
        return disposable();
      },
    },
  };

  return { vscode, state };
}

/** Load a fresh copy of the compiled extension against `vscode`. */
function loadExtension(vscodeModule) {
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscodeModule;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    // Only the entry point is emitted separately; `utils/install` and
    // `utils/config` are inlined into the bundle by esbuild.
    delete require.cache[require.resolve("../out/extension")];
    return require("../out/extension");
  } finally {
    Module._load = originalLoad;
  }
}

/** Executable stand-in for `pali` that prints the subcommand's JSON summary. */
const OK_STUB = `#!/bin/sh
case "$1" in
  index) printf '%s\\n' '{"files":3,"chunks":7,"index":"/w/.pali/index"}' ;;
  scan) printf '%s\\n' '{"repositories":1,"accepted_files":3,"findings":2,"insights":"/w/.pali/insights.json"}' ;;
  *) printf '%s\\n' '{"files":3,"sensitive":1,"findings":2,"report":"/w/.pali/scan.json"}' ;;
esac
`;

const FAIL_STUB = "#!/bin/sh\nexit 3\n";

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
}

/** One activation sandbox: extension root, storage, hooks dir, workspace. */
function makeSandbox({ bundled = true, settings = {}, workspaceFolders = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pali-act-"));
  const extensionPath = path.join(root, "ext");
  const storage = path.join(root, "storage");
  const hooksDir = path.join(root, "hooks");
  const instructionsFile = path.join(
    root,
    "user-instructions",
    "pali-memory.instructions.md",
  );
  const workspace = path.join(root, "workspace");
  for (const dir of [extensionPath, storage, workspace]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(extensionPath, "instructions"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionPath, "instructions", "pali-memory.instructions.md"),
    shippedInstructions,
    "utf8",
  );

  const bundledPath = bundledBinaryPath(extensionPath);
  if (bundled) writeExecutable(bundledPath, OK_STUB);

  const previousHooksDir = process.env.PALI_HOOKS_DIR;
  process.env.PALI_HOOKS_DIR = hooksDir;
  const previousInstructions = process.env.PALI_INSTRUCTIONS_PATH;
  process.env.PALI_INSTRUCTIONS_PATH = instructionsFile;

  // `pali.path` has a contributed default of "pali"; the fake config must
  // supply it too, or the installer sees an undefined path.
  const configuration = makeConfiguration({
    path: "pali",
    branch: "main",
    checkUpdates: false,
    ...settings,
  });
  const { vscode, state } = makeVscode({
    settings: configuration,
    workspaceFolders: workspaceFolders ? [{ uri: { fsPath: workspace } }] : undefined,
    rootPath: workspace,
  });

  const context = {
    extensionPath,
    globalStorageUri: { fsPath: storage },
    subscriptions: [],
    secrets: {
      get: async (key) => state.secrets.get(key),
      store: async (key, value) => {
        state.secrets.set(key, value);
      },
      delete: async (key) => {
        state.secrets.delete(key);
      },
    },
  };

  return {
    root,
    extensionPath,
    storage,
    hooksDir,
    instructionsFile,
    workspace,
    bundledPath,
    configuration,
    state,
    context,
    vscode,
    cleanup() {
      if (previousHooksDir === undefined) delete process.env.PALI_HOOKS_DIR;
      else process.env.PALI_HOOKS_DIR = previousHooksDir;
      if (previousInstructions === undefined) delete process.env.PALI_INSTRUCTIONS_PATH;
      else process.env.PALI_INSTRUCTIONS_PATH = previousInstructions;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Poll until `predicate` holds; activation settles asynchronously. */
async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readHookConfig(sandbox) {
  return JSON.parse(fs.readFileSync(path.join(sandbox.hooksDir, "pali.json"), "utf8"));
}

test("activation registers every contributed command and installs the hooks", async () => {
  const box = makeSandbox({ settings: { repoPath: "/memories", scope: "org/team" } });
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    // `installActivate` registers pali.install / pali.update after resolving the
    // UI, so the command surface is complete only once that settles.
    await waitFor(
      () => CONTRIBUTED_COMMANDS.every((id) => box.state.commands.has(id)),
      "the contributed commands",
    );
    assert.equal(box.state.providerId, "pali");

    await waitFor(
      () => fs.existsSync(path.join(box.hooksDir, "pali.json")),
      "the user-level hook config",
    );
    const hooks = readHookConfig(box);
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), [
      "agentStop",
      "sessionStart",
      "userPromptTransformed",
    ]);
    assert.match(hooks.hooks.sessionStart[0].bash, /PALI_SCOPE='org\/team'/);

    await waitFor(
      () => fs.existsSync(box.instructionsFile),
      "the user-level memory instructions",
    );
    const instructions = fs.readFileSync(box.instructionsFile, "utf8");
    assert.match(instructions, /^---\n/);
    assert.match(instructions, /^applyTo: '\*\*'$/m);
    assert.match(instructions, /`recall`/);
    assert.match(instructions, /`note`/);
    assert.match(instructions, /`read`/);
    assert.doesNotMatch(instructions, /`retain`|`reflect`/);

    // A bundled binary is re-resolved every activation and must not be written
    // into settings, which would pin the path of an older extension version.
    await waitFor(
      () => box.state.output.some((line) => line.includes("using binary at")),
      "binary resolution",
    );
    assert.ok(
      box.state.output.some((line) => line.includes(`(${"bundled"})`)),
      box.state.output.join("\n"),
    );
    assert.deepEqual(box.configuration.updates, [], "a bundled path is never persisted");
  } finally {
    box.cleanup();
  }
});

test("the MCP provider publishes a definition built from the resolved binary", async () => {
  const box = makeSandbox({
    settings: {
      repoPath: "/memories",
      scope: "org/team",
      remoteUrl: "https://example.com/mem.git",
      logLevel: "debug",
    },
  });
  box.state.secrets.set("gitToken", "ghp_secret");
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    const definitions = await box.state.provider.provideMcpServerDefinitions();
    assert.equal(definitions.length, 1, "a resolved binary yields one server");

    const [definition] = definitions;
    assert.ok(definition instanceof box.vscode.McpStdioServerDefinition);
    assert.equal(definition.command, box.bundledPath);
    assert.deepEqual(definition.args, ["serve"]);
    assert.equal(definition.env.PALI_REPO_PATH, "/memories");
    assert.equal(definition.env.PALI_GIT_TOKEN, "ghp_secret");
    assert.equal(definition.env.RUST_LOG, "pali=debug,info");
    assert.ok(
      box.state.output.some((line) => line.includes("(HTTPS token configured)")),
      "the log must say a token is configured without printing it",
    );
    assert.ok(!box.state.output.some((line) => line.includes("ghp_secret")));
  } finally {
    box.cleanup();
  }
});

test("a settings change rewrites the hooks and refreshes the server", async () => {
  const box = makeSandbox({ settings: { scope: "first" } });
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);
    await waitFor(() => fs.existsSync(path.join(box.hooksDir, "pali.json")), "initial hooks");

    box.state.provider.onDidChangeMcpServerDefinitions(() => {
      box.state.providerChanges += 1;
    });

    box.configuration.store.scope = "second";
    box.configuration.store.logLevel = "warn";
    for (const listener of box.state.configListeners) {
      listener({
        affectsConfiguration: (section) => section === "pali" || section.startsWith("pali."),
      });
    }

    await waitFor(
      () => readHookConfig(box).hooks.agentStop[0].bash.includes("PALI_SCOPE='second'"),
      "the rewritten hook config",
    );
    assert.ok(box.state.providerChanges >= 1, "VS Code must be told to re-read the definition");

    // A change to an unrelated section is ignored entirely.
    const before = box.state.providerChanges;
    for (const listener of box.state.configListeners) {
      listener({ affectsConfiguration: () => false });
    }
    assert.equal(box.state.providerChanges, before);
  } finally {
    box.cleanup();
  }
});

test("setToken stores, replaces, and clears the secret without touching settings", async () => {
  const box = makeSandbox();
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    box.state.input = "  ghp_new  ";
    await box.state.commands.get("pali.setToken")();
    assert.equal(box.state.secrets.get("gitToken"), "ghp_new", "the token is trimmed");

    box.state.input = "";
    await box.state.commands.get("pali.setToken")();
    assert.equal(box.state.secrets.has("gitToken"), false, "an empty entry clears the token");

    box.state.secrets.set("gitToken", "ghp_again");
    box.state.input = undefined;
    await box.state.commands.get("pali.setToken")();
    assert.equal(
      box.state.secrets.get("gitToken"),
      "ghp_again",
      "dismissing the prompt must not clear the token",
    );

    await box.state.commands.get("pali.clearToken")();
    assert.equal(box.state.secrets.has("gitToken"), false);
    assert.deepEqual(box.configuration.updates, [], "the token never reaches settings");
  } finally {
    box.cleanup();
  }
});

test("restart reports the resolved binary", async () => {
  const box = makeSandbox();
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    // The command returns immediately; the refresh itself is asynchronous.
    await box.state.commands.get("pali.restart")();
    await waitFor(
      () => box.state.output.some((line) => line.includes("using binary at")),
      "the restart binary line",
    );
  } finally {
    box.cleanup();
  }
});

test("workspace bootstrap runs each subcommand and reports its summary", async () => {
  const box = makeSandbox({ settings: { scanSaveMemories: true, repoPath: "/memories" } });
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);
    await waitFor(() => box.state.output.length > 0, "activation output");

    await box.state.commands.get("pali.scan")();
    await box.state.commands.get("pali.index")();

    assert.ok(
      box.state.infos.includes(
        "Pali: scanned 3 files (2 findings). Insights: /w/.pali/insights.json",
      ),
      box.state.infos.join("\n"),
    );
    assert.ok(
      box.state.infos.includes("Pali: indexed 7 chunks from 3 files. Index: /w/.pali/index"),
      box.state.infos.join("\n"),
    );
    assert.deepEqual(box.state.errors, [], "a successful run shows no error");
  } finally {
    box.cleanup();
  }
});

test("a failing bootstrap run reports the exit code", async () => {
  const box = makeSandbox();
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    writeExecutable(box.bundledPath, FAIL_STUB);
    await box.state.commands.get("pali.scan")();

    assert.ok(
      box.state.errors.some((message) => message.includes("scan failed (exit 3)")),
      box.state.errors.join("\n"),
    );
  } finally {
    box.cleanup();
  }
});

test("bootstrap without a workspace folder asks for one", async () => {
  const box = makeSandbox({ workspaceFolders: false });
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    await box.state.commands.get("pali.index")();
    assert.ok(
      box.state.errors.some((message) => message.includes("open a folder")),
      box.state.errors.join("\n"),
    );
  } finally {
    box.cleanup();
  }
});

test("bootstrap without a binary points at the install command", async () => {
  const box = makeSandbox({ bundled: false, settings: { path: "pali-does-not-exist-xyz" } });
  // A real `pali` on PATH would resolve and hide the missing-binary path this
  // test covers, so the lookup runs against an empty PATH.
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(box.root, "empty-path");
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);

    await box.state.commands.get("pali.scan")();
    assert.ok(
      box.state.errors.some((message) => message.includes('Run "Pali: Install pali" first')),
      box.state.errors.join("\n"),
    );
  } finally {
    process.env.PATH = previousPath;
    box.cleanup();
  }
});

test("an unusable pali.modelPath is reported once, then withheld", async () => {
  const box = makeSandbox({ settings: { modelPath: "/nonexistent/pali-model" } });
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);
    await waitFor(() => fs.existsSync(path.join(box.hooksDir, "pali.json")), "initial hooks");

    const first = box.state.errors.filter((message) => message.includes("pali.modelPath"));
    assert.equal(first.length, 1, box.state.errors.join("\n"));
    assert.ok(first[0].includes("is not usable"));

    // Repeated rewrites must not repeat the same notification.
    for (let i = 0; i < 3; i += 1) {
      for (const listener of box.state.configListeners) {
        listener({ affectsConfiguration: (section) => section.startsWith("pali.") });
      }
    }
    await waitFor(() => fs.existsSync(path.join(box.hooksDir, "pali.json")), "hooks");
    assert.equal(
      box.state.errors.filter((message) => message.includes("pali.modelPath")).length,
      1,
      "the same bad path is reported only once",
    );

    // The bad path is withheld from the hooks so the server keeps its default.
    assert.doesNotMatch(readHookConfig(box).hooks.sessionStart[0].bash, /PALI_MODEL_DIR/);
  } finally {
    box.cleanup();
  }
});

test("a configured binary is persisted to settings on activation", async () => {
  const box = makeSandbox({ bundled: false, settings: { path: "/nonexistent" } });
  const binary = path.join(box.root, "custom", process.platform === "win32" ? "pali.exe" : "pali");
  try {
    writeExecutable(binary, OK_STUB);
    box.configuration.store.path = binary;

    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);
    await waitFor(
      () => box.configuration.updates.some(([key]) => key === "path"),
      "the persisted path",
    );

    assert.deepEqual(
      box.configuration.updates.find(([key]) => key === "path"),
      ["path", binary],
      "a configured binary is written back so later activations reuse it",
    );
  } finally {
    box.cleanup();
  }
});

test("deactivate is a no-op that leaves the host clean", async () => {
  const box = makeSandbox();
  try {
    const extension = loadExtension(box.vscode);
    await extension.activate(box.context);
    assert.equal(extension.deactivate(), undefined);
    assert.ok(binaryName().length > 0);
  } finally {
    box.cleanup();
  }
});
