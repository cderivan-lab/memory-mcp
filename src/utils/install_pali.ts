// UI-agnostic install library for pali binaries.
// Used by install.ts (VS Code wrapper) and testable independently.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { log } from "./logger";
import modelManifest from "../model-manifest.json";

// Binaries and the embedding model are published by the project's GitHub
// repository. `releases/latest` is GitHub's stable alias for the newest
// release, so a download needs no version lookup. Downloads carry the HTTPS
// token the user stored via `pali.setToken` as a Bearer credential; a private
// repository needs it, a public one ignores it.
const GITHUB_BASE_URL = "https://github.com";
/**
 * REST host. It is not `${GITHUB_BASE_URL}/api/v3` (GitHub Enterprise's
 * path): github.com serves its API from `api.github.com/repos/<owner>/<repo>`,
 * and the `/api/v3` prefix there answers 404, which made every update check
 * come back empty.
 */
const GITHUB_API_URL = "https://api.github.com";
const PROJECT_PATH = "cderivan/memory-mcp";
/** Release download prefix. Asset names are per-target; see releaseAssetName. */
const RELEASE_BASE_URL = `${GITHUB_BASE_URL}/${PROJECT_PATH}/releases`;
/** Project REST root, used only to read the latest release's tag. */
const PROJECT_API_URL = `${GITHUB_API_URL}/repos/${PROJECT_PATH}`;

/**
 * Embedding model layout, read from `model-manifest.json`. The crate embeds the
 * same file (`pali/src/embedding/candle.rs`), so the directory this installer
 * writes to and the directory the server looks in cannot drift apart.
 */
export const MODEL_DIR_NAME = modelManifest.dir;
/** Every file the model loader requires, in manifest order. */
export const MODEL_FILES = [
  modelManifest.files.config,
  modelManifest.files.tokenizer,
  modelManifest.files.weights,
];
/** Project ref that carries the `models/<dir>.zip` archive. */
const MODEL_REF = "main";

// Log lines flow through the shared logger (src/utils/logger.ts): the
// extension host routes them into the "Pali Memory" output channel, and
// standalone runs (tests, scripts) keep the console. The level filter is the
// same `pali.logLevel` setting that drives the server and the hooks.

/** Map host platform/arch to a prebuilt release target, or null if unsupported. */
export function getReleaseTarget(platform: string, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return null;
}

/** Return the absolute path to `name` on PATH, or null if not found. */
export function which(name: string): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const { accessSync } = require("node:fs");
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // not found in this dir
    }
  }
  return null;
}

/**
 * Return true if `file` exists and is executable. Windows carries no exec
 * bits in the file mode, so existence is the whole check there.
 */
export async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** File name of the pali executable on the current platform. */
export function binaryName(): string {
  return process.platform === "win32" ? "pali.exe" : "pali";
}

/**
 * Return the release asset name for a target. The published assets are not
 * uniform: macOS is a single universal `aarch64-apple-darwin.zip` (used for
 * both arm64 and x64), Windows is `pali.x86_64-pc-windows-msvc.zip`, and
 * Linux x64 is a tarball `x86_64-unknown-linux-gnu.tgz`.
 */
export function releaseAssetName(target: string): string {
  if (target.includes("apple-darwin")) return "aarch64-apple-darwin.zip";
  if (target.includes("windows")) return `pali.${target}.zip`;
  return `${target}.tgz`;
}

/**
 * Build the download URL for a release target. Omitting `version` uses the
 * latest release, which is what the extension installs.
 */
export function releaseUrl(target: string, version?: string): string {
  const ref = version || "latest";
  return `${RELEASE_BASE_URL}/${ref}/download/${releaseAssetName(target)}`;
}

/** Path of the binary staged by `npm run build:binary`. */
export function bundledBinaryPath(extensionPath: string): string {
  return path.join(extensionPath, "out", "bin", binaryName());
}

/**
 * Return the decompressed bytes of the first archive entry that is the pali
 * executable, wherever it sits in the archive (the release may wrap it in a
 * versioned folder). The published archives carry a single executable entry
 * (named `pali`, `pali.exe`, or the bare target triple), so the first regular
 * file is taken. Returns null when none is found.
 */
function readBinaryFromZip(archive: Buffer): Buffer | null {
  let eocd = -1;
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let i = archive.length - 22; i >= earliest; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) return null;
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(start, start + compressedSize);
    return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
  }
  return null;
}

/**
 * Return the bytes of the first regular file in a (decompressed) tar archive,
 * or null when there is none. The Linux release archive holds a single
 * `pali` executable, so the first regular entry is the binary.
 */
function readBinaryFromTar(tar: Buffer): Buffer | null {
  for (let off = 0; off + 512 <= tar.length; off += 512) {
    const nameEnd = tar.indexOf(0, off, off + 100);
    if (nameEnd < 0) break;
    const name = tar.toString("utf8", off, nameEnd);
    if (!name) break;
    const type = tar[off + 156];
    if (type === 0x30) {
      const size =
        parseInt(
          tar
            .toString("utf8", off + 124, off + 136)
            .replace(/\0.*$/, "")
            .trim(),
          8,
        ) || 0;
      return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    }
    const size =
      parseInt(
        tar
          .toString("utf8", off + 124, off + 136)
          .replace(/\0.*$/, "")
          .trim(),
        8,
      ) || 0;
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Extract the pali executable out of a release archive into `destDir`, writing
 * it under the current platform's name. macOS and Windows archives are ZIPs;
 * the Linux archive is a gzip-compressed tar.
 */
export async function extractBinaryFromArchive(
  archive: Buffer,
  destDir: string,
  target: string,
): Promise<string> {
  const isTar = target.includes("linux");
  log.info(`reading ${isTar ? "tar.gz" : "zip"} archive (${archive.length} bytes)`);
  const bytes = isTar ? readBinaryFromTar(zlib.gunzipSync(archive)) : readBinaryFromZip(archive);
  if (!bytes) {
    log.error(`archive does not contain a ${binaryName()} executable`);
    throw new Error(`release archive does not contain a ${binaryName()} executable`);
  }
  const dest = path.join(destDir, binaryName());
  await fs.writeFile(dest, bytes);
  // The archive carries no permission bits, so restore the exec bit the
  // server needs to start (a no-op for the read-only bit on Windows).
  await fs.chmod(dest, 0o755);
  log.success(`extracted ${bytes.length} bytes of ${binaryName()}`);
  return dest;
}

/**
 * Read the first bytes of a file, or null when it cannot be read. Used to tell
 * a real binary or model file apart from an HTML login page a failed download
 * left behind.
 */
async function readBinaryHead(file: string, size = 64): Promise<Buffer | null> {
  const fh = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(size);
    const { bytesRead } = await fh.read(head, 0, size, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** True when the leading bytes look like an HTML document. */
function isHtmlHead(head: Buffer): boolean {
  const text = head.toString("utf8", 0, Math.min(256, head.length));
  return /^\s*<(\!doctype|html)/i.test(text) || /<html[^>]*>/i.test(text);
}

/** Directory holding the model files; `PALI_MODEL_DIR` points the server here. */
export function modelDir(storagePath: string): string {
  return path.join(storagePath, "models", MODEL_DIR_NAME);
}

/**
 * Return the model directory when every required file is present and non-empty,
 * or null when the model still needs to be downloaded.
 */
export async function resolveModelDir(storagePath: string): Promise<string | null> {
  const dir = modelDir(storagePath);
  for (const file of MODEL_FILES) {
    try {
      const st = await fs.stat(path.join(dir, file));
      if (!st.isFile() || st.size === 0) return null;
    } catch {
      return null;
    }
  }
  // A failed download can leave HTML login pages under the model file names;
  // those must not count as an installed model.
  const configHead = await readBinaryHead(path.join(dir, "config.json")).catch(() => null);
  if (configHead && isHtmlHead(configHead)) {
    log.warn(`model at ${dir} is an HTML login page, not a model — ignoring it`);
    return null;
  }
  return dir;
}

/**
 * Explain why a directory cannot serve as `PALI_MODEL_DIR`, or return
 * undefined when every required model file is present. An empty file is not
 * usable either: the server loads the weights at startup, so a truncated
 * install would fail there instead.
 */
export async function modelPathProblem(dir: string): Promise<string | undefined> {
  try {
    const entry = await fs.stat(dir);
    if (!entry.isDirectory()) return `"${dir}" is not a directory`;
  } catch {
    return `"${dir}" does not exist`;
  }

  const missing: string[] = [];
  for (const name of MODEL_FILES) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (!st.isFile() || st.size === 0) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length === 0) return undefined;
  return `"${dir}" is missing ${missing.join(", ")}`;
}

/** One Git LFS pointer, as committed instead of the file body. */
export interface LfsPointer {
  oid: string;
  size: number;
}

/**
 * Parse a Git LFS pointer file. Returns null for anything else, including the
 * real file contents, so callers can treat both repository layouts uniformly.
 */
export function parseLfsPointer(text: string): LfsPointer | null {
  if (!text.startsWith("version https://git-lfs")) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = Number(/^size (\d+)$/m.exec(text)?.[1]);
  if (!oid || !Number.isSafeInteger(size)) return null;
  return { oid, size };
}

/**
 * Resolve the pali binary to use. Checks configured binPath (if explicit),
 * then PATH (only for default "pali"), then the globalStorage cache.
 * Returns { path, source } where source is one of
 * 'configured', 'path', 'cache', or 'missing'.
 */
export interface ResolveResult {
  path: string | null;
  source: "bundled" | "configured" | "path" | "cache" | "missing";
}

export interface ResolveContext {
  globalStoragePath: string;
  /** Binary staged by the extension build (`out/bin/pali`), when present. */
  bundledPath?: string;
}

export interface ResolveConfig {
  binPath?: string;
}

export async function resolvePaliBinary(
  context: ResolveContext,
  config: ResolveConfig,
): Promise<ResolveResult> {
  // 0. Binary built and staged with the extension itself.
  if (context.bundledPath && (await isExecutable(context.bundledPath))) {
    log.debug(`bundled binary ${context.bundledPath} is present and executable, using it`);
    return { path: context.bundledPath, source: "bundled" };
  }

  // 1. Explicit binPath (not the default "pali")
  if (config.binPath && config.binPath !== "pali") {
    const resolved = path.isAbsolute(config.binPath)
      ? config.binPath
      : path.resolve(config.binPath);
    if (await isExecutable(resolved)) {
      return { path: resolved, source: "configured" };
    }
    // Fall through: explicit path was not executable
  }

  // 2. Default "pali" - check PATH
  if (!config.binPath || config.binPath === "pali") {
    const pathResult = which("pali");
    if (pathResult) {
      return { path: pathResult, source: "path" };
    }
  }

  // 3. globalStorage cache. The name matches what the installer extracts
  // (binaryName()), so a Windows install lands at `pali.exe` there. A failed
  // download may have left an HTML login page under that name, which must not
  // count as an installed binary — otherwise the re-install offer never shows.
  const cached = path.join(context.globalStoragePath, binaryName());
  if (await isExecutable(cached)) {
    const head = await readBinaryHead(cached).catch(() => null);
    if (head && isHtmlHead(head)) {
      log.warn(`cached binary ${cached} is an HTML login page, not a binary — ignoring it`);
      return { path: null, source: "missing" };
    }
    return { path: cached, source: "cache" };
  }

  // 4. Not found
  return { path: null, source: "missing" };
}

/** Maintenance flags in globalStorage alongside the binary. */
const MAINTENANCE_FILE = "maintenance.json";

interface MaintenanceData {
  installedVersion?: string;
  checkUpdates?: boolean;
}

/** Read maintenance flags from globalStorage. */
async function readMaintenance(storagePath: string): Promise<MaintenanceData> {
  const file = path.join(storagePath, MAINTENANCE_FILE);
  try {
    const content = await fs.readFile(file, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Write maintenance flags to globalStorage. Creates the directory if needed. */
async function writeMaintenance(storagePath: string, data: MaintenanceData): Promise<void> {
  await fs.mkdir(storagePath, { recursive: true });
  const file = path.join(storagePath, MAINTENANCE_FILE);
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/** Bearer credential for private-repo downloads, or no headers when unset. */
function authHeaders(token?: string | null): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

/** Read the newest release tag from the GitHub Enterprise API. */
async function fetchLatestVersion(token?: string | null): Promise<string | null> {
  try {
    const response = await fetch(`${PROJECT_API_URL}/releases/latest`, {
      headers: authHeaders(token),
    });
    if (!response.ok) return null;
    const release = (await response.json()) as { tag_name?: string };
    return release.tag_name?.trim() || null;
  } catch {
    return null;
  }
}

/** Read the full response body into memory, reporting byte progress. */
async function readBody(
  response: Response,
  onBytes: (received: number, total: number) => void,
): Promise<Buffer> {
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    received += chunk.byteLength;
    if (total > 0) onBytes(received, total);
  }
  return Buffer.concat(chunks);
}

/**
 * Validate the magic bytes of a downloaded archive. A 200 response can still
 * be an SSO login page (GitHub Enterprise redirects unauthenticated requests),
 * so the body must be inspected before it is trusted as a binary or model.
 */
function validateArchiveBytes(bytes: Buffer, dest: string): void {
  const isZip = bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304;
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isZip || isGzip) return;
  const head = bytes.toString("utf8", 0, Math.min(256, bytes.length));
  const isHtml = /^\s*<(\!doctype|html)/i.test(head) || /<html[^>]*>/i.test(head);
  if (isHtml) {
    log.error(`download of ${dest} returned an HTML login page, not an archive`);
    throw new Error(
      `The server returned a login page instead of the file for ${dest} ` +
        "(the download was redirected to single sign-on).\n" +
        'Run "Pali: Set HTTPS Token" and store a token with repo read access.',
    );
  }
  log.error(
    `download of ${dest} has unrecognized content ` +
      `(starts ${bytes.subarray(0, 8).toString("hex")})`,
  );
  throw new Error(
    `The downloaded file ${dest} is neither a zip nor a tar.gz archive. ` +
      "The release asset may have moved; check the release page or retry.",
  );
}

/** Bytes of a failed response body kept for the error message. */
const ERROR_SNIPPET_BYTES = 200;

/**
 * Read a short, single-line excerpt of a failed response body, so the error
 * names the page the server actually returned (an SSO interstitial, a
 * permission-denied notice) instead of only its status code. Reads at most
 * ERROR_SNIPPET_BYTES and cancels the stream, so a multi-megabyte error page is
 * never buffered, and never throws: a body that is absent or already consumed
 * just yields the empty string.
 */
async function readErrorSnippet(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    while (size < ERROR_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
    return Buffer.concat(chunks)
      .subarray(0, ERROR_SNIPPET_BYTES)
      .toString("utf8")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Write a response body to `dest` atomically, reporting byte progress. */
async function streamToFile(
  response: Response,
  dest: string,
  onBytes: (received: number, total: number) => void,
  mode?: number,
): Promise<void> {
  if (!response.ok || !response.body) {
    const base = `Server returned ${response.status} ${response.statusText} for ${response.url}`;
    // A private repo answers 401/403 when no (or a bad) token was supplied.
    const hint =
      response.status === 401 || response.status === 403
        ? '\nRun "Pali: Set HTTPS Token" and store a token with repo read access.'
        : "";
    const snippet = await readErrorSnippet(response);
    const detail = snippet ? `\nServer said: ${snippet}` : "";
    log.error(
      `${response.status} ${response.statusText} for ${response.url}` +
        (snippet ? `: ${snippet}` : ""),
    );
    throw new Error(base + hint + detail);
  }

  const bytes = await readBody(response, onBytes);
  validateArchiveBytes(bytes, dest);
  const tmp = `${dest}.download`;
  await fs.writeFile(tmp, bytes, mode ? { mode } : undefined);
  await fs.rename(tmp, dest);
  log.success(`wrote ${bytes.length} bytes to ${dest}`);
}

/** Download a file with progress reporting. */
async function downloadWithProgress(
  url: string,
  dest: string,
  onProgress: (fraction: number) => void,
  token?: string | null,
): Promise<void> {
  log.info(`downloading ${url}`);
  const tokenPresent = Boolean(authHeaders(token).Authorization);
  log.info(`authenticating with Bearer token: ${tokenPresent ? "yes" : "no"}`);
  const response = await fetch(url, { headers: authHeaders(token) });
  log.info(
    `server answered ${response.status} ${response.statusText} ` +
      `(content-type: ${response.headers.get("content-type") || "unknown"})`,
  );
  await streamToFile(
    response,
    dest,
    (received, total) => {
      onProgress(total > 0 ? received / total : 0);
    },
    0o755,
  );
}

/** Raw URL for the model archive at the tracked ref (GitHub Enterprise). */
function modelZipUrl(): string {
  return `${GITHUB_BASE_URL}/${PROJECT_PATH}/raw/${MODEL_REF}/models/${MODEL_DIR_NAME}.zip`;
}

/**
 * Extract every file entry of a ZIP archive into `destDir` using only
 * `node:zlib` (no external unzip binary). The central directory supplies each
 * entry's compression method and size; the local header locates the data.
 * Handles stored (method 0) and DEFLATE (method 8) entries and rejects any
 * entry that would escape `destDir` (zip-slip).
 */
async function extractZip(archive: Buffer, destDir: string): Promise<void> {
  let eocd = -1;
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let i = archive.length - 22; i >= earliest; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("model archive is not a valid ZIP");

  const root = path.resolve(destDir);
  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("corrupt ZIP central directory");
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // directory entry

    const dest = path.resolve(root, name);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new Error(`model archive entry escapes the model dir: ${name}`);
    }

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`corrupt ZIP local header for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(start, start + compressedSize);
    const bytes = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
  }
}

/** True when the model is already installed under the extension's storage. */
export async function hasModel(storagePath: string): Promise<boolean> {
  return (await resolveModelDir(storagePath)) !== null;
}

/**
 * Download the embedding model into the extension's storage. Returns the model
 * directory on success, or null after reporting the failure — the binary is
 * still usable with a model provisioned elsewhere (`PALI_MODEL_DIR`,
 * `scripts/fetch-model.sh`).
 */
export async function installModel(ui: UI): Promise<string | null> {
  const existing = await resolveModelDir(ui.storagePath);
  if (existing) return existing;

  const dir = modelDir(ui.storagePath);
  const zipPath = path.join(dir, `${MODEL_DIR_NAME}.zip`);
  log.info(`downloading model ${MODEL_DIR_NAME} from ${modelZipUrl()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await ui.progress(`Downloading the ${MODEL_DIR_NAME} model...`, null, async (report) => {
      await downloadWithProgress(modelZipUrl(), zipPath, report, await ui.getToken?.());
      // The archive holds the three model files at its root, so extracting
      // it into the model dir lands them exactly where the loader looks.
      await extractZip(await fs.readFile(zipPath), dir);
    });
  } catch (error) {
    log.error(`model download failed: ${(error as Error).message}`);
    ui.error(
      `Could not download the ${MODEL_DIR_NAME} model: ${(error as Error).message}\n` +
        "Run scripts/fetch-model.sh and set PALI_MODEL_DIR instead.",
    );
    return null;
  } finally {
    // Keep only the extracted files, not the archive.
    await fs.rm(zipPath, { force: true }).catch(() => {});
  }
  return dir;
}

/**
 * UI interface that the install library calls back into.
 * install.ts provides a VS Code implementation of this interface.
 */
export interface UI {
  paliPath: string; // get/set; sets paired promise in set paliPath
  storagePath: string; // readonly: globalStorage path
  extensionPath: string; // readonly: extension install path
  /**
   * HTTPS token for private-repo downloads, read from secret storage. Read
   * per download so a token set later via `pali.setToken` applies without a
   * reload. Returns null when none is stored.
   */
  getToken?(): Promise<string | null>;
  error(s: string): void;
  info(s: string): void;
  command(name: string, body: () => any): void;
  choose(prompt: string, options: string[]): Promise<string | undefined>;
  slow<T>(title: string, promise: Promise<T>): Promise<T>;
  progress<T>(
    title: string,
    cancel: AbortController | null,
    body: (progress: (fraction: number) => void) => Promise<T>,
  ): Promise<T>;
  localize(message: string, ...args: Array<string | number | boolean>): string;
  /**
   * Configured `pali.modelPath`, when the user set one. A usable directory
   * suppresses the model download offer: the server starts on it, so asking
   * to download a model would be wrong.
   */
  modelPath?: string;
  /**
   * Called after an install finishes, so the host can re-resolve the server
   * inputs and restart it: an install is the moment a server that had nothing
   * to start with becomes startable, without waiting for the next activation.
   */
  installed?(): void;
  shouldReuse(release: string): Promise<boolean | undefined>;
  promptReload(message: string): Promise<void>;
  promptUpdate(oldVersion: string, newVersion: string): Promise<void>;
  promptInstall(version: string): Promise<void>;
}

/**
 * Prepare the pali binary: resolve it, auto-install if missing (when
 * checkUpdates is true and binary is missing), and return the resolved path.
 */
/** Outcome of resolving everything the server needs to start. */
export interface PrepareResult {
  paliPath: string | null;
  modelDir: string | null;
  source: ResolveResult["source"];
}

/**
 * Return the model directory, offering a download when `offer` is set and the
 * model is not installed yet. Choosing "Later" (or dismissing the prompt)
 * leaves the model uninstalled for this session.
 */
/**
 * The configured `pali.modelPath` when it holds every model file, else null.
 * An unusable path must not suppress the download offer: the server cannot
 * start on it, and the extension reports that problem separately.
 */
async function usableConfiguredModel(ui: UI): Promise<string | null> {
  const configured = ui.modelPath?.trim();
  if (!configured) return null;
  return (await modelPathProblem(configured)) === undefined ? configured : null;
}

async function provisionModel(ui: UI, offer: boolean): Promise<string | null> {
  const configured = await usableConfiguredModel(ui);
  if (configured) return configured;
  const installed = await resolveModelDir(ui.storagePath);
  if (installed || !offer) return installed;

  const download = await ui.choose(
    `The ${MODEL_DIR_NAME} embedding model (about 130 MB) is not installed. Download it now?`,
    ["Download now", "Later"],
  );
  if (download !== "Download now") return null;
  const downloaded = await installModel(ui);
  if (downloaded) ui.installed?.();
  return downloaded;
}

/**
 * Offer to download the pali binary when it is missing. Choosing "Later" (or
 * dismissing the prompt) leaves the server uninstalled for this session.
 */
async function provisionBinary(ui: UI): Promise<boolean> {
  const download = await ui.choose("The pali binary was not found. Download and install it now?", [
    "Download now",
    "Later",
  ]);
  return download === "Download now";
}

export async function prepare(ui: UI, autoCheck: boolean): Promise<PrepareResult> {
  const resolve = () =>
    resolvePaliBinary(
      {
        globalStoragePath: ui.storagePath,
        bundledPath: bundledBinaryPath(ui.extensionPath),
      },
      { binPath: ui.paliPath },
    );

  let resolved = await resolve();
  log.info(`resolved pali binary from ${resolved.source} (${resolved.path ?? "not found"})`);

  // The missing-binary offer is unconditional. `checkUpdates` governs update
  // prompts for an installed binary; gating first-install on it rebinds the
  // prompt to the wrong question, and leaves an installation that can never
  // start once update checks are off.
  let modelOffered = false;
  if (resolved.source === "missing") {
    if (await provisionBinary(ui)) {
      let installed = false;
      try {
        // installLatest asks for the model in the same flow.
        await installLatest(ui);
        installed = true;
      } catch (error) {
        ui.error(`Could not install pali: ${(error as Error).message}`);
      }
      modelOffered = installed;
      resolved = await resolve();
    }
    if (resolved.source === "missing") {
      // Nothing can start without the binary, so the model prompt would only
      // be noise: the server would still be unstartable.
      return { paliPath: null, modelDir: null, source: resolved.source };
    }
  }

  // A bundled binary is versioned with the extension, so the release channel
  // and its update prompts do not apply. The model is still needed, and so is
  // it when the binary was found on PATH or in the cache.
  const modelDir = modelOffered
    ? ((await usableConfiguredModel(ui)) ?? (await resolveModelDir(ui.storagePath)))
    : await provisionModel(ui, true);

  if (resolved.source === "bundled") {
    return { paliPath: resolved.path, modelDir, source: resolved.source };
  }

  // If found on PATH, cache the absolute path so we do not re-search.
  if (resolved.source === "path" && resolved.path) {
    ui.paliPath = resolved.path;
  }

  // Check for updates if enabled
  if (autoCheck) {
    await checkUpdates(false, ui);
  }

  return {
    paliPath: resolved.path,
    modelDir,
    source: resolved.source,
  };
}

/**
 * Download and install the latest pali release for the current platform,
 * together with the embedding model the server needs at startup.
 * Throws if platform is unsupported or download fails.
 */
export async function installLatest(ui: UI): Promise<void> {
  const target = getReleaseTarget(process.platform, process.arch);
  if (!target) {
    log.error(`no prebuilt binary for ${process.platform}-${process.arch}`);
    throw new Error(
      `Prebuilt binaries are not available for ${process.platform}-${process.arch}. ` +
        `Set "pali.path" to a manually built pali, or download from the release page.`,
    );
  }
  log.info(`installing pali for ${process.platform}-${process.arch} (target ${target})`);

  // Only prompt about reuse if a cached binary is actually on disk.
  const existingPath = path.join(ui.storagePath, binaryName());
  const maintenance = await readMaintenance(ui.storagePath);
  const installedVersion = maintenance.installedVersion;
  if (installedVersion && (await isExecutable(existingPath))) {
    const shouldReuse = await ui.shouldReuse(installedVersion);
    if (shouldReuse === false) {
      try {
        await fs.unlink(existingPath);
      } catch {
        // ignore
      }
    } else if (shouldReuse === true) {
      ui.info(`pali ${installedVersion} is already installed.`);
      return;
    }
    // If undefined (dismissed), fall through and reinstall
  }

  // Ensure the storage directory exists before writing the binary.
  await fs.mkdir(ui.storagePath, { recursive: true });

  await ui.progress(`Installing pali (${target})...`, null, async (reportProgress) => {
    const url = releaseUrl(target);
    const archivePath = path.join(ui.storagePath, releaseAssetName(target));
    const dest = path.join(ui.storagePath, binaryName());
    log.info(`release asset: ${releaseAssetName(target)} from ${url}`);
    try {
      await downloadWithProgress(url, archivePath, reportProgress, await ui.getToken?.());
      log.info(`extracting ${binaryName()} from ${path.basename(archivePath)}...`);
      await extractBinaryFromArchive(await fs.readFile(archivePath), ui.storagePath, target);
      log.success(`binary extracted to ${dest}`);
      ui.paliPath = dest;
    } finally {
      // Keep only the extracted executable, not the archive.
      await fs.rm(archivePath, { force: true }).catch(() => {});
    }

    // Try to get the version from the binary. `pali --version` prints
    // "pali <semver>"; keep only the version so update checks compare tags.
    let version = "latest";
    try {
      const { execFile } = require("node:child_process");
      const { promisify } = require("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(dest, ["--version"]);
      version = stdout.trim().split(/\s+/).pop() || "latest";
    } catch {
      // Keep 'latest' if version check fails
    }

    await writeMaintenance(ui.storagePath, {
      installedVersion: version,
      checkUpdates: true,
    });
  });

  // The server cannot start without the embedding model, so offer it in the
  // same install flow. The prompt keeps the ~130 MB download a user choice;
  // installModel reports its own failure, so a model problem never blocks the
  // binary install.
  await provisionModel(ui, true);

  await ui.promptReload(`pali installed at ${ui.paliPath}`);
}

/** Normalise a release tag for comparison ("v1.0.0" and "1.0.0" are equal). */
function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/**
 * Check for updates. If force is true, always check even if the user
 * previously dismissed. If force is false, respect the checkUpdates setting.
 */
export async function checkUpdates(force: boolean, ui: UI): Promise<void> {
  const maintenance = await readMaintenance(ui.storagePath);
  if (!force && maintenance.checkUpdates === false) {
    return; // user previously dismissed
  }

  const target = getReleaseTarget(process.platform, process.arch);
  if (!target) return;

  const latestVersion = await fetchLatestVersion(await ui.getToken?.());
  if (!latestVersion) return;

  const installedVersion = maintenance.installedVersion;
  if (!installedVersion || normalizeVersion(installedVersion) !== normalizeVersion(latestVersion)) {
    await ui.promptUpdate(installedVersion || "unknown", latestVersion);
  }
}
