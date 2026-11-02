#!/usr/bin/env node
/**
 * Offline stand-in for `pali serve --transport stdio`, used by the test suite.
 *
 * Every `tools/call` is appended to $STUB_LOG as one JSON line. `list` answers
 * from $STUB_LIST (a JSON array of memory summaries); `note` and `forget`
 * answer with a fixed success payload, so tests can assert on what the hooks
 * asked for without touching the real memory repository.
 */

import { appendFileSync } from "node:fs";

const LOG = process.env.STUB_LOG;
let buffer = "";
let seenCall = false;

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function record(name, args) {
  if (!LOG) return;
  appendFileSync(LOG, `${JSON.stringify({ tool: name, args })}\n`);
}

function listMemories() {
  let raw = process.env.STUB_LIST || "[]";
  if (raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function handle(message) {
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "stub-pali", version: "1" },
    });
    return;
  }
  if (message.method !== "tools/call") return;

  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  record(name, args);
  seenCall = true;

  if (process.env.STUB_FAIL_TOOL && process.env.STUB_FAIL_TOOL === name) {
    reply(message.id, { isError: true, content: [{ type: "text", text: "stub failure" }] });
    return;
  }

  if (name === "list") {
    const memories = listMemories();
    reply(
      message.id,
      textResult({ count: memories.length, returned: memories.length, limit: args.limit ?? 10, has_more: false, memories }),
    );
  } else if (name === "note") {
    reply(message.id, textResult({ id: `stub-${String(args.name).slice(-12)}`, name: args.name, scope: args.scope }));
  } else if (name === "forget") {
    reply(message.id, textResult({ deleted: true, name: args.name }));
  } else if (name === "recall") {
    reply(message.id, textResult({ results: [] }));
  } else {
    reply(message.id, textResult({ ok: true }));
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {}
  }
  // The hook sends its three frames in one write; once the call is answered the
  // real client kills us, so there is nothing left to wait for.
  if (seenCall) {
    const timer = setTimeout(() => process.exit(0), 20);
    timer.unref?.();
    process.exitCode = 0;
  }
});
