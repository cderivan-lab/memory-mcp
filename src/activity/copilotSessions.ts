// Copilot session management utilities for the Pali Memory extension.
// These functions handle the recording of Copilot CLI sessions to the memory store.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ExtensionSettings } from '../utils/lib';

/**
 * Session capture configuration for Copilot sessions.
 * Records session transcripts as deterministic digest memories.
 */
export interface CopilotSessionConfig {
  /** Scope for the memory store (defaults to workspace folder name). */
  scope?: string;
  /** Path to the transcript file. */
  transcriptPath?: string;
  /** Unique session identifier. */
  sessionId?: string;
  /** Current working directory for relative path resolution. */
  cwd?: string;
  /** Maximum number of sessions to retain per scope (0 disables pruning). */
  keepSessions?: number;
}

/**
 * Result of a session capture attempt.
 */
export interface SessionCaptureResult {
  /** Whether the session was written to the memory store. */
  written: boolean;
  /** Name of the captured session memory. */
  name?: string;
  /** Reason when not written. */
  reason?: 'empty' | 'unchanged';
  /** Number of turns in the transcript. */
  turns?: number;
  /** Number of tool executions in the transcript. */
  tools?: number;
}

/**
 * Session statistics returned after a capture operation.
 */
export interface SessionStats {
  /** Total number of captured sessions in scope. */
  total: number;
  /** Number of sessions currently retained. */
  retained: number;
  /** Names of sessions that were pruned. */
  pruned: string[];
}

/**
 * Format a memory block containing Copilot session memories.
 */
export interface MemoryBlock {
  scope: string;
  memories: Array<{ name: string; content: string }>;
  intro?: string;
  budget?: number;
}

/**
 * Recall memories relevant to a Copilot session.
 */
export interface RecallResult {
  memories: Array<{
    name: string;
    content: string;
    created_at?: string;
  }>;
}

/**
 * Record an additional context memory from a Copilot session.
 */
export interface AdditionalContext {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

/**
 * Transform a prompt with recalled session memories.
 */
export interface PromptTransform {
  originalPrompt: string;
  modifiedTransformedPrompt?: string;
  memoriesInjected: number;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/** One turn in a Copilot session transcript. */
export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

/** One tool execution in a transcript. */
export interface TranscriptTool {
  name: string;
  args: Record<string, unknown>;
  succeeded?: boolean;
  error?: string;
  exitCode?: number;
}

/** Parsed transcript with turns and tools. */
export interface ParsedTranscript {
  turns: TranscriptTurn[];
  tools: TranscriptTool[];
}

/** Limits for transcript parsing. */
const TRANSCRIPT_LIMITS = {
  bytes: 32 * 1024 * 1024,
  requests: 10,
  requestChars: 400,
  outcomeChars: 3000,
  files: 40,
  fileChars: 200,
  commands: 12,
  commandChars: 200,
  failures: 5,
  failureChars: 300,
  toolNames: 8,
  contentChars: 16000,
};

/** Tools whose execution mutates files. */
const WRITE_TOOLS = new Set([
  'edit', 'create', 'write', 'apply_patch', 'multiedit',
  'multi_edit', 'str_replace', 'replace', 'insert',
  'notebook_edit', 'delete_file', 'remove_file',
]);

/** Keys that contain file paths in tool arguments. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'target_file'];

/** Argument keys that indicate file text content. */
const WRITE_ARG_HINTS = ['new_str', 'new_string', 'file_text', 'fileText', 'content'];

/**
 * Collapse whitespace in text.
 */
export function collapse(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Strip memory blocks from content.
 */
export function stripMemoryBlocks(content: string): string {
  const re = /<pali_memory>[\s\S]*?<\/pali_memory>/g;
  return content.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Compute SHA-256 hash.
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Parse a transcript file into turns and tools.
 */
export function parseTranscript(transcriptPath: string): ParsedTranscript {
  let raw: string;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size > TRANSCRIPT_LIMITS.bytes) {
      return { turns: [], tools: [] };
    }
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { turns: [], tools: [] };
  }

  const turns: TranscriptTurn[] = [];
  const tools: TranscriptTool[] = [];
  const byCallId = new Map<string, TranscriptTool>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const evt = event as { type?: string; data?: unknown; timestamp?: string };
    const data = evt.data as Record<string, unknown> | undefined;

    switch (evt.type) {
      case 'user.message':
      case 'assistant.message': {
        const content =
          typeof data?.content === 'string' ? stripMemoryBlocks(data.content).trim() : '';
        if (content) {
          turns.push({
            role: evt.type === 'user.message' ? 'user' : 'assistant',
            content,
            timestamp: evt.timestamp,
          });
        }
        break;
      }
      case 'tool.execution_start': {
        const tool: TranscriptTool = {
          name: typeof data?.toolName === 'string' ? data.toolName : 'unknown',
          args: data?.arguments && typeof data.arguments === 'object' ? data.arguments as Record<string, unknown> : {},
          succeeded: undefined,
          error: '',
          exitCode: undefined,
        };
        tools.push(tool);
        if (typeof data?.toolCallId === 'string') {
          byCallId.set(data.toolCallId, tool);
        }
        break;
      }
      case 'tool.execution_complete': {
        const tool =
          typeof data?.toolCallId === 'string' ? byCallId.get(data.toolCallId) : undefined;
        if (!tool) break;
        tool.succeeded = data?.success !== false;
        const errorObj = (data?.error as Record<string, unknown> | undefined)?.message;
        tool.error = collapse(errorObj).slice(0, TRANSCRIPT_LIMITS.failureChars);
        const shellExec = (data?.shellExecution as Record<string, unknown> | undefined);
        const exitCode = typeof shellExec?.exitCode === 'number' ? shellExec.exitCode : undefined;
        if (typeof exitCode === 'number') {
          tool.exitCode = exitCode;
        }
        break;
      }
    }
  }
  return { turns, tools };
}

// ---------------------------------------------------------------------------
// Session digest building
// ---------------------------------------------------------------------------

/** Check if transcript has content worth capturing. */
export function hasContent(session: ParsedTranscript): boolean {
  return Boolean(session?.turns?.length || session?.tools?.length);
}

/** Get day string from session turns for naming. */
export function dayOf(turns: TranscriptTurn[]): string {
  const day = turns[0]?.timestamp?.substring(0, 10) ?? new Date().toISOString().substring(0, 10);
  return day;
}

/** Generate session memory name. */
export function sessionName(params: {
  day: string;
  sessionId?: string;
  transcriptPath?: string;
}): string {
  const suffix =
    String(params.sessionId ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 40) ||
    sha256(String(params.transcriptPath ?? 'unknown')).slice(0, 12);
  return `copilot-session-${params.day}-${suffix}`;
}

/** Check if tool execution writes to files. */
function isWriteTool(toolName: string, args: Record<string, unknown>): boolean {
  const name = String(toolName ?? '').toLowerCase();
  const writeish =
    WRITE_TOOLS.has(name) || WRITE_ARG_HINTS.some((hint) => typeof args[hint] === 'string' && String(args[hint]).trim());
  if (!writeish) return false;
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return true;
  }
  return false;
}

/** Build a deterministic digest for a session. */
export function buildDigest(
  session: ParsedTranscript,
  _config: { cwd?: string; scope?: string; sessionId?: string },
): string | null {
  if (!hasContent(session)) return null;

  const parts: string[] = [];

  // Requests (user prompts)
  const requests = session.turns
    .filter((t) => t.role === 'user')
    .slice(-TRANSCRIPT_LIMITS.requests)
    .map((t) => collapse(t.content).slice(0, TRANSCRIPT_LIMITS.requestChars));

  if (requests.length) {
    parts.push('## Requests\n');
    requests.forEach((r, i) => parts.push(`${i + 1}. ${r}\n`));
  }

  // Files modified
  const files: string[] = [];
  const seen = new Set<string>();
  for (const tool of session.tools) {
    if (isWriteTool(tool.name, tool.args)) {
      for (const key of PATH_KEYS) {
        const value = tool.args[key];
        if (typeof value === 'string' && value.trim()) {
          if (!seen.has(value)) {
            seen.add(value);
            files.push(value.slice(0, TRANSCRIPT_LIMITS.fileChars));
            if (files.length >= TRANSCRIPT_LIMITS.files) break;
          }
        }
      }
    }
  }
  if (files.length) {
    parts.push('\n## Files modified\n');
    files.forEach((f) => parts.push(`- ${f}\n`));
  }

  // Recent commands
  const commands: string[] = [];
  for (let i = session.tools.length - 1; i >= 0 && commands.length < TRANSCRIPT_LIMITS.commands; i--) {
    const tool = session.tools[i];
    if (tool.succeeded === false) continue;
    const cmd = collapse(tool.args.command ?? tool.args.cmd ?? '').slice(0, TRANSCRIPT_LIMITS.commandChars);
    if (cmd && !commands.includes(cmd)) {
      commands.push(cmd);
    }
  }
  commands.reverse();
  if (commands.length) {
    parts.push('\n## Commands\n');
    commands.forEach((c) => parts.push(`\`${c}\`\n`));
  }

  // Failures
  const failures: string[] = [];
  for (let i = session.tools.length - 1; i >= 0 && failures.length < TRANSCRIPT_LIMITS.failures; i--) {
    const tool = session.tools[i];
    const failed = tool.succeeded === false || (typeof tool.exitCode === 'number' && tool.exitCode !== 0);
    if (!failed) continue;
    const cmd = collapse(tool.args.command ?? tool.args.cmd ?? '').slice(0, TRANSCRIPT_LIMITS.commandChars);
    const detail = [cmd ? `\`${cmd}\`` : '', tool.error].filter(Boolean).join(' — ') || 'failed';
    const exit = typeof tool.exitCode === 'number' ? ` (exit ${tool.exitCode})` : '';
    const line = `${tool.name}${exit}: ${collapse(detail).slice(0, TRANSCRIPT_LIMITS.failureChars)}`;
    if (!failures.includes(line)) {
      failures.push(line);
    }
  }
  failures.reverse();
  if (failures.length) {
    parts.push('\n## Failures\n');
    failures.forEach((f) => parts.push(`${f}\n`));
  }

  // Tool activity summary
  const counts = new Map<string, number>();
  for (const tool of session.tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  const activity = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TRANSCRIPT_LIMITS.toolNames)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');

  if (activity) {
    parts.push(`\n## Tool activity\n${activity}\n`);
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Memory block formatting
// ---------------------------------------------------------------------------

/** Format memory block for injection into Copilot context. */
export function formatMemoryBlock(params: MemoryBlock): string {
  const intro = params.intro !== undefined ? params.intro : '';
  const budget = params.budget ?? 0;

  if (!params.memories.length) return '';

  const blocks: string[] = [];
  let total = intro.length;

  for (const mem of params.memories) {
    const marker = `<pali_memory>`;
    const closeMarker = `</pali_memory>`;
    const block = `${marker}${mem.content}${closeMarker}\n`;

    if (total + block.length > budget && total > 0) {
      break;
    }
    blocks.push(block);
    total += block.length;
  }

  return intro + blocks.join('');
}

// ---------------------------------------------------------------------------
// Scope sanitization
// ---------------------------------------------------------------------------

function sanitizeComponent(component: string): string {
  return component
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.]+/, '_')
    .replace(/^-+|-+$/g, '');
}

/** Sanitize a scope name for use in memory storage. */
export function sanitizeScope(value: string): string {
  const components = String(value)
    .split('/')
    .map(sanitizeComponent)
    .filter(Boolean)
    .slice(0, 10);
  return components.length ? components.join('/') : 'unknown-project';
}

/** Get project scope from working directory. */
export function projectScope(cwd: string, config?: ExtensionSettings): string {
  if (config?.scope) return sanitizeScope(config.scope);
  let name = '';
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 4000,
    }).trim();
    if (result) name = path.basename(result);
  } catch {
    /* empty */
  }
  if (!name) name = path.basename(cwd || process.cwd());
  return sanitizeScope(name);
}

// ---------------------------------------------------------------------------
// Utility: execSync wrapper
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tags for classifying Copilot session memories (exported for test use). */
export const SESSION_TAGS = ['session', 'auto-capture', 'harness:copilot-cli'];
/** Prefix for Copilot session memory names (exported for test use). */
export const NAME_PREFIX = 'copilot-session-';