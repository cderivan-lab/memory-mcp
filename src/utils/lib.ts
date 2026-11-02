// Core pure-logic helpers for the Pali VS Code extension.
// These are UI- and VS Code-agnostic so they can be unit-tested without
// the extension host. The activate/deactivate entry points live in
// extension.ts and wire these into the VS Code API.

import * as path from 'node:path';
import {
  getReleaseTarget,
  releaseUrl,
  resolvePaliBinary,
  ResolveResult,
  ResolveContext,
  ResolveConfig,
} from './install_pali';
import { rustLogFilter } from './logger';
import type { LogLevel } from './logger';

/** Settings exposed by this extension. */
export interface ExtensionSettings {
  binPath: string;
  repoPath: string;
  remoteUrl: string;
  branch: string;
  scope: string;
  // Directory of an auto-installed embedding model, when one is present.
  modelDir?: string;
  // Log level for the extension, the MCP server, and the hooks (default
  // `info`). One knob drives the whole project's verbosity.
  logLevel?: LogLevel;
}

/** One hook command carrying the settings the scripts read from the environment. */
function hookCommand(
  script: string,
  mode: string,
  config: ExtensionSettings,
  shell: 'bash' | 'powershell',
): string {
  const env: [string, string][] = [
    ['PALI_BIN', config.binPath],
    ['PALI_REPO_PATH', config.repoPath],
    ['PALI_SCOPE', config.scope],
    // The hooks read the same level the extension and server use, so the
    // hook log at ~/.pali-hooks/hook.log stays consistent with the rest.
    ['PALI_HOOK_LOG_LEVEL', config.logLevel],
  ].filter((pair): pair is [string, string] => Boolean(pair[1]));

  if (shell === 'bash') {
    const prefix = env
      .map(([key, value]) => `${key}=${bashQuote(value)}`)
      .join(' ');
    return `${prefix ? `${prefix} ` : ''}node ${bashQuote(script)} ${mode}`;
  }
  const prefix = env
    .map(([key, value]) => `$env:${key}=${powershellQuote(value)};`)
    .join(' ');
  return `${prefix ? `${prefix} ` : ''}node ${powershellQuote(script)} ${mode}`;
}

/** Copilot hooks file for the three events this extension wires up. */
export function buildHookConfig(
  extensionPath: string,
  config: ExtensionSettings,
): { version: 1; hooks: Record<string, HookEntry[]> } {
  const script = path.join(extensionPath, 'hooks', 'copilot-hooks.mjs');
  const entry = (mode: string, timeoutSec: number): HookEntry => ({
    type: 'command',
    bash: hookCommand(script, mode, config, 'bash'),
    powershell: hookCommand(script, mode, config, 'powershell'),
    timeoutSec,
  });
  return {
    version: 1,
    hooks: {
      sessionStart: [entry('session-start', 30)],
      userPromptTransformed: [entry('prompt', 30)],
      agentStop: [entry('stop', 60)],
    },
  };
}

interface HookEntry {
  type: 'command';
  bash: string;
  powershell: string;
  timeoutSec: number;
}

/** Stringify the hook config with a trailing newline. */
export function hookConfigBody(extensionPath: string, config: ExtensionSettings): string {
  return `${JSON.stringify(buildHookConfig(extensionPath, config), null, 2)}\n`;
}

/** Stdio server definition for VS Code's MCP server definition provider. */
export interface McpServerDefinition {
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function mcpServerDefinition(
  config: ExtensionSettings,
  token: string | undefined,
): McpServerDefinition {
  const env: Record<string, string> = { PALI_BRANCH: config.branch };
  if (config.repoPath) env.PALI_REPO_PATH = config.repoPath;
  if (config.remoteUrl) env.PALI_REMOTE_URL = config.remoteUrl;
  // The token comes from secret storage, not settings, and only authenticates
  // HTTPS transports. A local path remote never needs one, so it is not passed
  // there — that would widen the token's exposure for no reason.
  if (token && /^https?:\/\//i.test(config.remoteUrl || '')) {
    env.PALI_GIT_TOKEN = token;
  }
  // The server refuses to start without model files. Point it at the copy the
  // extension installed; without this it falls back to the platform data dir.
  if (config.modelDir) env.PALI_MODEL_DIR = config.modelDir;
  // The server's tracing filter (RUST_LOG) mirrors the extension's log level
  // so `pali.logLevel` controls both sides of the pipe. The filter is scoped
  // to the `pali` crate so `debug` does not flood the server with dependency
  // noise.
  if (config.logLevel) env.RUST_LOG = rustLogFilter(config.logLevel);

  return {
    label: 'Pali Memory',
    command: config.binPath,
    args: ['serve'],
    env,
  };
}

// Re-export from install_pali for test compatibility
export { getReleaseTarget, releaseUrl, resolvePaliBinary };
export type { ResolveResult, ResolveContext, ResolveConfig };

function bashQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}