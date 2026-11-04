// Core pure-logic helpers for the Pali VS Code extension.
// These are UI- and VS Code-agnostic so they can be unit-tested without
// the extension host. The activate/deactivate entry points live in
// extension.ts and wire these into the VS Code API.

import * as path from "node:path";
import {
  getReleaseTarget,
  releaseUrl,
  resolvePaliBinary,
  ResolveResult,
  ResolveContext,
  ResolveConfig,
} from "./install_pali";
import { rustLogFilter } from "./logger";
import type { LogLevel } from "./logger";

/** Settings exposed by this extension. */
export interface ExtensionSettings {
  binPath: string;
  repoPath: string;
  remoteUrl: string;
  branch: string;
  scope: string;
  // Directory of an auto-installed embedding model, when one is present.
  modelDir?: string;
  // Explicit model directory from `pali.modelPath`; wins over `modelDir`.
  modelPath?: string;
  // Log level for the extension, the MCP server, and the hooks (default
  // `info`). One knob drives the whole project's verbosity.
  logLevel?: LogLevel;
  // Record git blame commit IDs and line numbers in the scan manifest.
  scanBlame?: boolean;
  // Maximum size of a file included by a repository scan.
  scanMaxFileBytes?: number;
  // Save the insight digest as a memory in the memory repository.
  scanSaveMemories?: boolean;
}

/** One hook command carrying the settings the scripts read from the environment. */
function hookCommand(
  script: string,
  mode: string,
  config: ExtensionSettings,
  shell: "bash" | "powershell",
): string {
  const env: [string, string][] = [
    ["PALI_BIN", config.binPath],
    ["PALI_REPO_PATH", config.repoPath],
    ["PALI_SCOPE", config.scope],
    // The hooks read the same level the extension and server use, so the
    // hook log at ~/.pali-hooks/hook.log stays consistent with the rest.
    ["PALI_HOOK_LOG_LEVEL", config.logLevel],
    // The hook-spawned server embeds recall queries, so it needs the model
    // too; the user's explicit model path wins over the installed copy.
    ["PALI_MODEL_DIR", config.modelPath || config.modelDir],
  ].filter((pair): pair is [string, string] => Boolean(pair[1]));

  // Uninstall and updates delete the extension directory while a hook file
  // written earlier can outlive it. Running node on the missing entry point
  // crashes every event with MODULE_NOT_FOUND, so skip the run quietly and
  // leave the host with a successful, empty hook result.
  if (shell === "bash") {
    const prefix = env.map(([key, value]) => `${key}=${bashQuote(value)}`).join(" ");
    const run = `${prefix ? `${prefix} ` : ""}node ${bashQuote(script)} ${mode}`;
    return `[ -f ${bashQuote(script)} ] || exit 0; ${run}`;
  }
  const prefix = env.map(([key, value]) => `$env:${key}=${powershellQuote(value)};`).join(" ");
  const run = `${prefix ? `${prefix} ` : ""}node ${powershellQuote(script)} ${mode}`;
  return `if (-not (Test-Path -LiteralPath ${powershellQuote(script)})) { exit 0 }; ${run}`;
}

/** Copilot hooks file for the three events this extension wires up. */
export function buildHookConfig(
  extensionPath: string,
  config: ExtensionSettings,
): { version: 1; hooks: Record<string, HookEntry[]> } {
  const script = path.join(extensionPath, "hooks", "copilot-hooks.mjs");
  const entry = (mode: string, timeoutSec: number): HookEntry => ({
    type: "command",
    bash: hookCommand(script, mode, config, "bash"),
    powershell: hookCommand(script, mode, config, "powershell"),
    timeoutSec,
  });
  return {
    version: 1,
    hooks: {
      sessionStart: [entry("session-start", 30)],
      userPromptTransformed: [entry("prompt", 30)],
      agentStop: [entry("stop", 60)],
    },
  };
}

interface HookEntry {
  type: "command";
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
  const env: Record<string, string> = { PALI_BRANCH: config.branch, NO_COLOR: "1" };
  if (config.repoPath) env.PALI_REPO_PATH = config.repoPath;
  if (config.remoteUrl) env.PALI_REMOTE_URL = config.remoteUrl;
  // The token comes from secret storage, not settings, and only authenticates
  // HTTPS transports. A local path remote never needs one, so it is not passed
  // there — that would widen the token's exposure for no reason.
  if (token && /^https?:\/\//i.test(config.remoteUrl || "")) {
    env.PALI_GIT_TOKEN = token;
  }
  // The server refuses to start without model files. An explicit
  // `pali.modelPath` wins; otherwise point it at the copy the extension
  // installed; without either it falls back to the platform data dir.
  if (config.modelPath) env.PALI_MODEL_DIR = config.modelPath;
  else if (config.modelDir) env.PALI_MODEL_DIR = config.modelDir;
  // The server's tracing filter (RUST_LOG) mirrors the extension's log level
  // so `pali.logLevel` controls both sides of the pipe. The filter is scoped
  // to the `pali` crate so `debug` does not flood the server with dependency
  // noise.
  if (config.logLevel) env.RUST_LOG = rustLogFilter(config.logLevel);

  return {
    label: "Pali Memory",
    command: config.binPath,
    args: ["serve"],
    env,
  };
}

/** Workspace bootstrap subcommands that run against a folder on disk. */
export type WorkspaceBootstrapKind = "scan" | "index" | "scan-repos";

/** A resolved CLI invocation for one workspace bootstrap run. */
export interface WorkspaceBootstrapCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build the `pali scan` / `pali index` invocation for a workspace folder.
 *
 * The CLI writes its artifacts under `<workspace>/.pali` by default. `scan`
 * and `scan-repos` only read text files and never load the model; `index`
 * embeds every chunk, so it receives the same model directory the server
 * uses. `scan-repos` alone can commit the insight digest into the memory
 * repository (`--save-memories`), which is the only path here that writes
 * outside the artifacts directory.
 */
export function workspaceBootstrapCommand(
  kind: WorkspaceBootstrapKind,
  config: ExtensionSettings,
  workspaceRoot: string,
): WorkspaceBootstrapCommand {
  const env: Record<string, string> = { NO_COLOR: "1" };
  if (kind === "index") {
    const modelDir = config.modelPath || config.modelDir;
    if (modelDir) env.PALI_MODEL_DIR = modelDir;
  }
  // Every subcommand logs through tracing, so the configured level applies the
  // same way it does to the server and the hooks.
  if (config.logLevel) env.RUST_LOG = rustLogFilter(config.logLevel);

  const args = [kind, "--workspace", workspaceRoot];
  if (kind === "scan-repos") {
    if (config.scanBlame) args.push("--blame");
    if (config.scanMaxFileBytes) {
      args.push("--max-file-bytes", String(config.scanMaxFileBytes));
    }
    if (config.scanSaveMemories) {
      args.push("--save-memories");
      // The CLI defaults to ~/.memory-mcp and the workspace directory name;
      // only pass values the user actually configured.
      if (config.repoPath) args.push("--repo-path", config.repoPath);
      if (config.scope) args.push("--scope", config.scope);
    }
  }

  return { command: config.binPath, args, env };
}

/**
 * Turn the JSON summary a bootstrap subcommand prints on stdout into the
 * one-line message shown to the user. Unparseable output is passed through so
 * an older binary's plain-text summary is still visible.
 */
export function workspaceBootstrapSummary(
  kind: WorkspaceBootstrapKind,
  stdout: string,
): string {
  const text = stdout.trim();
  let summary: Record<string, unknown>;
  try {
    summary = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return text || `Pali: ${kind} finished without a summary`;
  }
  const count = (key: string): number => Number(summary[key] ?? 0);
  if (kind === "scan-repos") {
    return (
      `Pali: scanned ${count("accepted_files")} files ` +
      `(${count("findings")} findings). Insights: ${summary.insights}`
    );
  }
  if (kind === "scan") {
    return (
      `Pali: scanned ${count("files")} files ` +
      `(${count("sensitive")} sensitive, ${count("findings")} potential secrets). ` +
      `Report: ${summary.report}`
    );
  }
  return (
    `Pali: indexed ${count("chunks")} chunks from ${count("files")} files. ` +
    `Index: ${summary.index}`
  );
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
