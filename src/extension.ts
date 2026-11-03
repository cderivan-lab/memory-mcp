// Pali Memory VS Code Extension
// Registers the Pali memory MCP server and installs its GitHub Copilot hooks.

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
  mcpServerDefinition,
  ExtensionSettings,
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
 * failure, and the server can still start on the installed model.
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
      'Fix the setting, or clear it to use the installed model.';
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
  const modelDir = await resolveModelDir(context.globalStorageUri.fsPath);
  return {
    binPath: binary.path ?? configured,
    repoPath: String(config.get('repoPath') || '').trim(),
    remoteUrl: String(config.get('remoteUrl') || '').trim(),
    branch: String(config.get('branch') || 'main').trim() || 'main',
    scope: String(config.get('scope') || '').trim(),
    modelDir: modelDir ?? undefined,
    modelPath: await usableModelPath(String(config.get('modelPath') || '').trim()),
    logLevel: normalizeLogLevel(config.get('logLevel')),
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
  } catch {
    // Missing file: write it below.
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
    const modelDir = await resolveModelDir(context.globalStorageUri.fsPath);
    output.appendLine(
      `pali: using binary at ${resolved.path} (${resolved.source})` +
        (modelDir ? ` (model: ${modelDir})` : ' (no installed model)'),
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

  // Initialize the pali binary: resolve existing or offer to install. The
  // token getter reads secret storage per download so a token set via
  // `pali.setToken` unlocks the private-repo binary and model downloads.
  installActivate(
    context.subscriptions,
    context.globalStorageUri.fsPath,
    context.extensionPath,
    () => void refreshServer(context, serverChanged, output),
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