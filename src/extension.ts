// Pali Memory VS Code Extension
// Registers the Pali memory MCP server and installs its GitHub Copilot hooks.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activate as installActivate } from './utils/install';
import {
  bundledBinaryPath,
  MODEL_FILES,
  modelPathProblem,
  resolveModelDir,
  resolvePaliBinary,
} from './utils/install_pali';
import type { ResolveResult } from './utils/install_pali';
import {
  hookConfigBody,
  installInstructions,
  installSkill,
  mcpServerDefinition,
  skillInstallPath,
  userInstructionsPath,
  workspaceBootstrapCommand,
  workspaceBootstrapSummary,
  ExtensionSettings,
} from './utils/lib';
import type {
  WorkspaceBootstrapCommand,
  WorkspaceBootstrapKind,
} from './utils/lib';
import { log, normalizeLogLevel } from './utils/logger';

const CONFIG_SECTION = 'pali';
const MCP_PROVIDER_ID = 'pali';
const TOKEN_KEY = 'gitToken';

/**
 * Resolve the binary that would actually run: the copy staged by
 * `npm run build:binary`, a configured path, PATH, or the auto-installed
 * cache. `path` is null when none of them exists.
 */
async function resolveBinary(
  context: vscode.ExtensionContext,
): Promise<ResolveResult> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configured = String(config.get('path') || 'pali').trim() || 'pali';
  return resolvePaliBinary(
    {
      globalStoragePath: context.globalStorageUri.fsPath,
      bundledPath: bundledBinaryPath(context.extensionPath),
    },
    { binPath: configured },
  );
}

/**
 * The last unusable `pali.modelPath` reported, so the provider and every hook
 * rewrite do not repeat the same notification.
 */
let reportedModelPath: string | undefined;

/**
 * Accept `pali.modelPath` only when the directory holds the model files the
 * server loads. A bad value is reported once and withheld from the server and
 * the hooks: passing it on would only surface later as an opaque startup
 * failure, and the server can still resolve the model itself.
 */
async function usableModelPath(configured: string): Promise<string | undefined> {
  if (!configured) {
    reportedModelPath = undefined;
    return undefined;
  }
  const problem = await modelPathProblem(configured);
  if (!problem) {
    reportedModelPath = undefined;
    return configured;
  }
  if (reportedModelPath !== configured) {
    reportedModelPath = configured;
    const message =
      `Pali: pali.modelPath is not usable — ${problem}. ` +
      `The server needs ${MODEL_FILES.join(', ')}. ` +
      'Fix the setting, or clear it to let the server resolve the model itself.';
    log.error(message);
    void vscode.window.showErrorMessage(message);
  }
  return undefined;
}

/**
 * Read settings for the hooks and the server definition. The installed model
 * directory travels with the same binary resolution.
 */
async function settings(
  context: vscode.ExtensionContext,
  resolved?: ResolveResult,
): Promise<ExtensionSettings> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configured = String(config.get('path') || 'pali').trim() || 'pali';
  const binary = resolved ?? (await resolveBinary(context));
  return {
    binPath: binary.path ?? configured,
    repoPath: String(config.get('repoPath') || '').trim(),
    remoteUrl: String(config.get('remoteUrl') || '').trim(),
    remoteSync: config.get<boolean>('remoteSync') ?? false,
    branch: String(config.get('branch') || 'main').trim() || 'main',
    scope: String(config.get('scope') || '').trim(),
    modelPath: await usableModelPath(String(config.get('modelPath') || '').trim()),
    logLevel: normalizeLogLevel(config.get('logLevel')),
    scanBlame: Boolean(config.get('scanBlame')),
    scanMaxFileBytes: Number(config.get('scanMaxFileBytes')) || undefined,
    scanSaveMemories: config.get<boolean>('scanSaveMemories') ?? true,
  };
}

/**
 * The user-level Copilot hooks file. VS Code reads `<home>/.copilot/hooks/*.json`
 * for every workspace, so one install covers every project instead of leaving
 * a `.github/hooks/pali.json` copy behind in each one. `pali.scope` (or the
 * hook's own git-repo derivation) still keeps memories per project.
 *
 * `PALI_HOOKS_DIR` overrides the directory so tests never write the real one.
 */
function hookConfigPath(): string {
  const dir =
    process.env.PALI_HOOKS_DIR || path.join(os.homedir(), '.copilot', 'hooks');
  return path.join(dir, 'pali.json');
}

/** Write the user-level hooks file, leaving it untouched when it is current. */
async function installHooks(
  context: vscode.ExtensionContext,
  quiet: boolean,
): Promise<boolean> {
  const target = hookConfigPath();
  const body = hookConfigBody(context.extensionPath, await settings(context));
  let current = '';
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch(error) {
      log.error(`Pali: could not read hook config: ${(error as Error).message}`);
  }
  if (current === body) return true;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  } catch (error) {
    if (!quiet) {
      vscode.window.showWarningMessage(
        `Pali: could not write the hook config: ${(error as Error).message}`,
      );
    }
    return false;
  }
  return true;
}

/**
 * Re-resolve the binary and model, then ask VS Code to re-read the server
 * definition. Installs end here so a server that had nothing to start with
 * comes up without a window reload.
 */
async function refreshServer(
  context: vscode.ExtensionContext,
  serverChanged: vscode.EventEmitter<void>,
  output: vscode.OutputChannel,
): Promise<void> {
  const resolved = await resolveBinary(context);
  if (!resolved.path) {
    output.appendLine('pali: binary still not found; MCP server not started');
  } else {
    output.appendLine(
      `pali: using binary at ${resolved.path} (${resolved.source})`,
    );
  }
  serverChanged.fire();
}

/**
 * Update the pali.path setting to point to the installed binary and fire
 * the server change event so VS Code re-requests the MCP definition.
 */
async function updateBinPathSetting(
  newPath: string,
  serverChanged: vscode.EventEmitter<void>,
  output: vscode.OutputChannel,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('path', newPath, vscode.ConfigurationTarget.Global);
  output.appendLine(`pali: path updated to ${newPath}`);
  serverChanged.fire();
}

/** One `pali scan` / `pali index` run, from spawn to exit. */
interface BootstrapOutcome {
  code: number | null;
  stdout: string;
  cancelled: boolean;
}

/**
 * Run a bootstrap subcommand, mirroring its stderr (the CLI's tracing output)
 * into the output channel. Cancelling the progress notification kills the
 * child, so a long `index` run does not have to finish to be abandoned.
 */
function runBootstrap(
  invocation: WorkspaceBootstrapCommand,
  output: vscode.OutputChannel,
  cancellation: vscode.CancellationToken,
): Promise<BootstrapOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: { ...process.env, ...invocation.env },
      windowsHide: true,
    });
    let stdout = '';
    let cancelled = false;
    const subscription = cancellation.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output.append(chunk.toString());
    });
    child.on('error', (error) => {
      subscription.dispose();
      reject(error);
    });
    child.on('close', (code) => {
      subscription.dispose();
      resolve({ code, stdout, cancelled });
    });
  });
}

/**
 * Run `pali scan` or `pali index` against the first workspace folder. The
 * subcommands read the folder and write only under its `.pali/` artifacts
 * directory, so this never touches the memory repository.
 */
async function bootstrapWorkspace(
  kind: WorkspaceBootstrapKind,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  const labels: Record<WorkspaceBootstrapKind, string> = {
    scan: 'Scan workspace',
    index: 'Index workspace',
  };
  const label = labels[kind];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage(
      `Pali: open a folder before running "Pali: ${label}".`,
    );
    return;
  }

  const resolved = await resolveBinary(context);
  if (!resolved.path) {
    void vscode.window.showErrorMessage(
      'Pali: the pali binary was not found. Run "Pali: Install pali" first.',
    );
    return;
  }

  const invocation = workspaceBootstrapCommand(
    kind,
    await settings(context, resolved),
    folder.uri.fsPath,
  );
  output.show(true);
  output.appendLine(
    `pali ${kind}: ${invocation.command} ${invocation.args.join(' ')}`,
  );

  let outcome: BootstrapOutcome;
  try {
    outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pali: ${label.toLowerCase()} ${path.basename(folder.uri.fsPath)}`,
        cancellable: true,
      },
      (_, cancellation) => runBootstrap(invocation, output, cancellation),
    );
  } catch (error) {
    const message = `Pali: could not run "${invocation.command}": ${(error as Error).message}`;
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
    return;
  }

  if (outcome.cancelled) {
    output.appendLine(`pali ${kind}: cancelled`);
    return;
  }
  if (outcome.code !== 0) {
    const message =
      `Pali: ${kind} failed (exit ${outcome.code ?? 'signal'}). ` +
      'See the "Pali Memory" output for details.';
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
    return;
  }

  const message = workspaceBootstrapSummary(kind, outcome.stdout);
  output.appendLine(message);
  void vscode.window.showInformationMessage(message);
}

function activate(context: vscode.ExtensionContext): void {
  // Event emitter to signal VS Code to re-request the MCP server definition
  const serverChanged = new vscode.EventEmitter<void>();
  const output = vscode.window.createOutputChannel('Pali Memory');
  context.subscriptions.push(serverChanged, output);

  // Route every extension- and install-side log line through the shared
  // logger into the output channel, at the level the user configured. The
  // same level is passed to the MCP server (RUST_LOG) and the hooks
  // (PALI_HOOK_LOG_LEVEL) via the settings below, so one knob controls the
  // whole project's verbosity.
  log.setSink((line) => output.appendLine(line));
  log.setLevel(normalizeLogLevel(
    vscode.workspace.getConfiguration(CONFIG_SECTION).get('logLevel'),
  ));

  // The token lives in secret storage (the OS keychain), not in settings.json,
  // so it never lands in a workspace file that can be committed or synced.
  const setToken = async (): Promise<void> => {
    const entered = await vscode.window.showInputBox({
      title: 'Pali: HTTPS personal access token',
      prompt:
        'Stored in VS Code\'s secret storage, never in settings.json. Leave empty to clear.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'ghp_…',
    });
    if (entered === undefined) return; // cancelled

    const token = entered.trim();
    if (!token) {
      await context.secrets.delete(TOKEN_KEY);
      output.appendLine('cleared HTTPS token');
    } else {
      await context.secrets.store(TOKEN_KEY, token);
      output.appendLine('stored HTTPS token in secret storage');
    }
    serverChanged.fire();
  };

  const clearToken = async (): Promise<void> => {
    await context.secrets.delete(TOKEN_KEY);
    output.appendLine('cleared HTTPS token');
    serverChanged.fire();
  };

  context.subscriptions.push(
    // Prompted installs and hook rewrites end by asking for a restart; firing
    // the change event makes VS Code re-request the server definition.
    vscode.commands.registerCommand('pali.restart', () =>
      void refreshServer(context, serverChanged, output)),
    vscode.commands.registerCommand('pali.setToken', setToken),
    vscode.commands.registerCommand('pali.clearToken', clearToken),
    vscode.commands.registerCommand('pali.scan', () =>
      bootstrapWorkspace('scan', context, output)),
    vscode.commands.registerCommand('pali.index', () =>
      bootstrapWorkspace('index', context, output)),
    vscode.lm?.registerMcpServerDefinitionProvider?.(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: serverChanged.event,
      provideMcpServerDefinitions: async (): Promise<vscode.McpServerDefinition[]> => {
        // Resolve before answering. A definition whose command does not exist
        // only produces a spawn ENOENT when VS Code starts it, so with no
        // binary there is no server to offer: activation has prompted to
        // install one, and `Pali: Install pali` can be run explicitly.
        const resolved = await resolveBinary(context);
        if (!resolved.path) {
          output.appendLine(
            'MCP server not started: the pali binary was not found. ' +
              'Run "Pali: Install pali", then restart the server.',
          );
          return [];
        }
        const token = await context.secrets.get(TOKEN_KEY);
        // Resolution carries the staged binary and the installed model, so
        // the server definition never falls back to defaults that miss them.
        const definition = mcpServerDefinition(
          await settings(context, resolved),
          token,
        );
        output.appendLine(
          `MCP server definition: ${definition.command} ${definition.args.join(' ')}` +
            (definition.env.PALI_GIT_TOKEN ? ' (HTTPS token configured)' : '') +
            (definition.env.PALI_MODEL_DIR ? ` (model: ${definition.env.PALI_MODEL_DIR})` : ''),
        );
        return [
          new vscode.McpStdioServerDefinition(
            definition.label,
            definition.command,
            definition.args,
            definition.env,
          ),
        ];
      },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      if (event.affectsConfiguration(`${CONFIG_SECTION}.logLevel`)) {
        log.setLevel(normalizeLogLevel(
          vscode.workspace.getConfiguration(CONFIG_SECTION).get('logLevel'),
        ));
      }
      void installHooks(context, true);
      serverChanged.fire();
    }),
  );

  output.appendLine(
    typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function'
      ? `registered MCP server definition provider "${MCP_PROVIDER_ID}"`
      : 'this VS Code build has no MCP server definition provider API; update VS Code 1.101 or newer',
  );

  // Install the Copilot hooks
  void installHooks(context, true);

  // Install the agent-facing skill once per user, like the hooks. A missing
  // source or an unwritable home is reported but never blocks activation.
  const skill = installSkill(context.extensionPath);
  if (skill === 'installed') {
    output.appendLine(`pali: installed skill at ${skillInstallPath()}`);
  } else if (skill === 'failed') {
    output.appendLine('pali: could not install the Pali Memory skill');
  }

  // Copy the always-on memory rule into the user-level instructions folder.
  // It is a dedicated `*.instructions.md` file, so the user's
  // `copilot-instructions.md` is never rewritten.
  const instructions = installInstructions(context.extensionPath);
  if (instructions === 'installed') {
    output.appendLine(
      `pali: installed memory instructions at ${userInstructionsPath()}`,
    );
  } else if (instructions === 'missing') {
    output.appendLine(
      'pali: memory instructions are missing from this extension build',
    );
  } else if (instructions === 'failed') {
    output.appendLine(
      `pali: could not install memory instructions at ${userInstructionsPath()}`,
    );
  }

  // Initialize the pali binary: resolve existing or offer to install. The
  // token getter reads secret storage per download so a token set via
  // `pali.setToken` unlocks private-repo binary downloads.
  installActivate(
    context.subscriptions,
    context.globalStorageUri.fsPath,
    context.extensionPath,
    async () => (await context.secrets.get(TOKEN_KEY)) ?? null,
  )
    .then((status) => {
      if (!status.paliPath) {
        output.appendLine('pali: binary not found; awaiting user action');
        return;
      }
      output.appendLine(`pali: using binary at ${status.paliPath} (${status.source})`);
      // A bundled binary lives in the extension's own directory and changes
      // with the extension version, so it is re-resolved on every activation
      // instead of being written into settings.
      if (status.source !== 'bundled') {
        updateBinPathSetting(status.paliPath, serverChanged, output);
      }
    })
    .catch((error) => {
      output.appendLine(`pali: binary resolution failed: ${error.message}`);
    });

  // The install.ts handles auto-check and registration of pali.install/pali.update/pali.restart
}

function deactivate(): void {}

export { activate, deactivate };