import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LIMITS,
  buildDigest,
  collectCommands,
  collectFailures,
  collectFiles,
  dayOf,
  hasContent,
  readTranscript,
  sessionName,
} from "../pali-session-digest.mjs";
import {
  assistant,
  sampleSession,
  tempDir,
  toolFail,
  toolOk,
  toolStart,
  user,
  writeTranscript,
} from "./helpers.mjs";

const scope = "demo";
const cwd = "/tmp/project";

function digestOf(events, overrides = {}) {
  const dir = tempDir();
  const path = writeTranscript(dir, events);
  return buildDigest(readTranscript(path), { scope, sessionId: "sess-1", cwd, ...overrides });
}

function section(digest, title) {
  const match = digest.match(new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?:\\n\\n## |$)`));
  return match ? match[1].trim() : "";
}

test("digest renders header, requests and tool activity", () => {
  const digest = digestOf(sampleSession());
  assert.match(digest, /^# Copilot session — demo — 2026-10-28/);
  assert.match(digest, /- Scope: demo/);
  assert.match(digest, /- Session: sess-1/);
  assert.match(digest, /- Turns: 1 user \/ 2 assistant/);
  assert.match(digest, /- Tool calls: 5/);
  assert.equal(section(digest, "Requests"), "1. Fix the login redirect loop in the desktop app");
  assert.equal(section(digest, "Tool activity"), "bash×2, create×1, edit×1, view×1");
  assert.match(section(digest, "Final assistant message"), /Fixed the redirect loop/);
});

test("only write tools contribute files, and paths inside cwd are relative", () => {
  const events = [
    user("touch files"),
    toolStart("a", "view", { path: "/tmp/project/docs/notes.md" }),
    toolOk("a"),
    toolStart("b", "grep", { query: "token" }),
    toolOk("b"),
    toolStart("c", "edit", { path: "/tmp/project/src/handler.ts", new_str: "x" }),
    toolOk("c"),
    toolStart("d", "create", { path: "/tmp/project/src/new.ts", file_text: "y" }),
    toolOk("d"),
    toolStart("e", "edit", { path: "src/already-relative.ts", new_str: "z" }),
    toolOk("e"),
    toolStart("f", "edit", { path: "/elsewhere/outside.ts", new_str: "w" }),
    toolOk("f"),
  ];
  const files = section(digestOf(events), "Files modified").split("\n").map((line) => line.replace(/^- `|`$/g, ""));
  assert.deepEqual(files, ["src/handler.ts", "src/new.ts", "src/already-relative.ts", "/elsewhere/outside.ts"]);
  assert.ok(!files.some((file) => file.includes("notes.md")), "read-only view() must not count as a write");
});

test("files, commands and failures keep their most useful window", () => {
  const editTools = Array.from({ length: 60 }, (_, index) => ({
    name: "edit",
    args: { path: `/tmp/project/src/file-${index}.ts`, new_str: "x" },
  }));
  assert.equal(collectFiles(editTools, cwd).length, LIMITS.files);
  assert.equal(collectFiles(editTools, cwd)[0], "src/file-0.ts");

  const commands = Array.from({ length: 20 }, (_, index) => ({
    name: "bash",
    args: { command: `run step ${index}` },
    succeeded: true,
  }));
  const kept = collectCommands(commands);
  assert.equal(kept.length, LIMITS.commands);
  assert.equal(kept[0], "run step 8");
  assert.equal(kept.at(-1), "run step 19");

  const failures = Array.from({ length: 8 }, (_, index) => ({
    name: "bash",
    args: { command: `broken ${index}` },
    succeeded: false,
    error: `error ${index}`,
    exitCode: 1,
  }));
  const recent = collectFailures(failures);
  assert.equal(recent.length, LIMITS.failures);
  assert.match(recent[0], /broken 3/);
  assert.match(recent.at(-1), /broken 7/);
});

test("requests are capped at the oldest ten", () => {
  const events = [];
  for (let index = 0; index < 15; index += 1) events.push(user(`request number ${index}`));

  const digest = digestOf(events);
  const requests = section(digest, "Requests").split("\n").filter((line) => /^\d+\. /.test(line));
  assert.equal(requests.length, LIMITS.requests);
  assert.equal(requests[0], "1. request number 0");
  assert.equal(requests.at(-1), "10. request number 9");
  assert.ok(!digest.includes("request number 10"), "requests past the cap are dropped");
});

test("adjacent duplicate requests collapse and injected memory is stripped", () => {
  const digest = digestOf([
    user("same question"),
    user("same question"),
    user("<pali_memory>\nINJECTED MEMORY\n</pali_memory>\nreal request"),
    user("later question"),
  ]);
  assert.equal(section(digest, "Requests"), "1. same question\n2. real request\n3. later question");
  assert.ok(!digest.includes("INJECTED MEMORY"));
});

test("digest stays inside the content budget", () => {
  const long = "x".repeat(LIMITS.requestChars + 50);
  const events = [];
  for (let index = 0; index < 12; index += 1) events.push(user(`${index} ${long}`));
  for (let index = 0; index < 40; index += 1) {
    events.push(toolStart(`e${index}`, "edit", { path: `/tmp/project/${"d/".repeat(90)}file-${index}.ts`, new_str: "x" }));
    events.push(toolOk(`e${index}`));
    events.push(toolStart(`c${index}`, "bash", { command: `command ${index} ${"y".repeat(250)}` }));
    events.push(toolOk(`c${index}`, { shellExecution: { exitCode: 0 } }));
  }
  for (let index = 0; index < 6; index += 1) {
    events.push(toolStart(`f${index}`, "bash", { command: `fail ${index}` }));
    events.push(toolFail(`f${index}`, "z".repeat(LIMITS.failureChars + 50), { shellExecution: { exitCode: 2 } }));
  }
  events.push(assistant("z".repeat(LIMITS.outcomeChars + 500)));

  const digest = digestOf(events);
  assert.ok(digest.length <= LIMITS.contentChars, `digest was ${digest.length} chars`);
  assert.match(digest, /^# Copilot session — demo/);
});

test("sessions without a user request produce no digest", () => {
  assert.equal(digestOf([assistant("nothing asked")]), null);
  assert.equal(digestOf([]), null);
});

test("transcripts tolerate malformed lines and missing files", () => {
  const dir = tempDir();
  const path = join(dir, "events.jsonl");
  writeFileSync(path, `${JSON.stringify(user("keep me"))}\n{not json\n\n${JSON.stringify(toolStart("t", "bash", { command: "ls" }))}\n`);
  const session = readTranscript(path);
  assert.equal(session.turns.length, 1);
  assert.equal(session.tools.length, 1);
  assert.deepEqual(readTranscript(join(dir, "missing.jsonl")), { turns: [], tools: [] });
  assert.equal(hasContent({ turns: [], tools: [] }), false);
  assert.equal(hasContent(session), true);
});

test("day comes from the first timestamped turn", () => {
  assert.equal(dayOf([user("a", "2026-09-02T23:59:00.000Z"), user("b", "2026-09-03T00:01:00.000Z")]), "2026-09-02");
  assert.match(dayOf([user("no timestamp", undefined)]), /^\d{4}-\d{2}-\d{2}$/);
});

test("the checkout line is only added inside a git worktree", () => {
  const repo = tempDir("pali-digest-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"],
    { cwd: repo },
  );

  const path = writeTranscript(repo, sampleSession());
  const digest = buildDigest(readTranscript(path), { scope, sessionId: "sess-1", cwd: repo });
  assert.match(digest, /- Checkout: (main|master) @ [0-9a-f]{7,}/);
});

test("session names are stable and filesystem-safe", () => {
  const withId = sessionName({ day: "2026-10-28", sessionId: "e417c42a-9a6b-4e2a-990c-0f42ecf59f38", transcriptPath: "/x" });
  assert.equal(withId, "copilot-session-2026-10-28-e417c42a-9a6b-4e2a-990c-0f42ecf59f38");

  const sanitized = sessionName({ day: "2026-10-28", sessionId: "../../etc/passwd", transcriptPath: "/x" });
  assert.match(sanitized, /^copilot-session-2026-10-28-[A-Za-z0-9._-]+$/);
  assert.ok(!sanitized.includes("/"));

  const withoutId = sessionName({ day: "2026-10-28", sessionId: "", transcriptPath: "/a/b.jsonl" });
  assert.equal(withoutId, sessionName({ day: "2026-10-28", sessionId: "", transcriptPath: "/a/b.jsonl" }));
  assert.notEqual(withoutId, sessionName({ day: "2026-10-28", sessionId: "", transcriptPath: "/a/c.jsonl" }));
});

test("tool completions update the matching execution", () => {
  const path = writeTranscript(tempDir(), [
    user("run it"),
    toolStart("id-1", "bash", { command: "make" }),
    toolFail("id-1", "boom", { shellExecution: { exitCode: 3 } }),
  ]);
  const [tool] = readTranscript(path).tools;
  assert.equal(tool.succeeded, false);
  assert.equal(tool.error, "boom");
  assert.equal(tool.exitCode, 3);
});
