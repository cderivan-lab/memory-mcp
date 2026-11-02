import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assistant,
  callsOf,
  hookEnv,
  runHook,
  sampleSession,
  tempDir,
  user,
  writeTranscript,
} from "./helpers.mjs";

const SESSION_ID = "e417c42a-9a6b-4e2a-990c-0f42ecf59f38";

function setup(events = sampleSession()) {
  const dir = tempDir();
  const transcriptPath = writeTranscript(dir, events);
  const env = hookEnv(dir);
  return { dir, transcriptPath, env, event: { sessionId: SESSION_ID, cwd: dir, transcriptPath } };
}

function sessionMemories(count, keepNewestOrder = true) {
  const memories = [];
  for (let index = 0; index < count; index += 1) {
    memories.push({
      name: `copilot-session-2026-10-2${index}-old-session-${index}`,
      scope: "test-project",
      tags: ["session", "auto-capture"],
      created_at: `2026-10-2${index}T00:00:00.000Z`,
      updated_at: `2026-10-2${index}T00:00:00.000Z`,
    });
  }
  return keepNewestOrder ? memories.reverse() : memories;
}

test("captures one digest memory for the session", () => {
  const { env, event, dir } = setup();
  const result = runHook(env, event, { cwd: dir });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "", "capture writes nothing to stdout");

  const notes = callsOf(env, "note");
  assert.equal(notes.length, 1);
  const { name, scope, tags, content, source } = notes[0].args;
  assert.equal(scope, "test-project");
  assert.match(name, new RegExp(`^copilot-session-2026-10-28-${SESSION_ID.slice(0, 8)}`));
  assert.deepEqual(tags, ["session", "auto-capture", "harness:copilot-cli"]);
  assert.equal(source, "copilot-stop-hook");
  assert.match(content, /## Requests/);
  assert.match(content, /## Files modified/);
  assert.match(content, /`src\/auth\/handler\.ts`/);
  assert.match(content, /## Commands run/);
  assert.match(content, /## Failures/);
  assert.match(content, /bash \(exit 1\): `dotnet build/);

  assert.ok(existsSync(join(env.PALI_HOOK_STATE_DIR, "stop", `${name}.json`)), "state records the captured hash");
});

test("re-running on an unchanged transcript writes nothing", () => {
  const { env, event, dir } = setup();
  runHook(env, event, { cwd: dir });
  const second = runHook(env, event, { cwd: dir });

  assert.equal(second.status, 0);
  assert.equal(callsOf(env, "note").length, 1, "idempotent: same digest must not create a second memory");
});

test("a changed transcript refreshes the same memory name", () => {
  const { dir, env, event } = setup();
  runHook(env, event, { cwd: dir });

  const grown = [...sampleSession(), user("Now add a regression test"), assistant("Adding the test.")];
  writeFileSync(event.transcriptPath, grown.map((line) => JSON.stringify(line)).join("\n"));
  runHook(env, event, { cwd: dir });

  const notes = callsOf(env, "note");
  assert.equal(notes.length, 2);
  assert.equal(notes[0].args.name, notes[1].args.name, "upsert under the same session name");
  assert.match(notes[1].args.content, /Now add a regression test/);
});

test("capture can be disabled", () => {
  const { dir, event } = setup();
  const env = hookEnv(dir, { PALI_HOOK_CAPTURE: "0" });
  const result = runHook(env, event, { cwd: dir });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(callsOf(env, "note").length, 0);
});

test("bad input is silent and exit 0", () => {
  const dir = tempDir();
  const env = hookEnv(dir);

  const malformed = runHook(env, null, { cwd: dir, input: "{not json" });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");

  const empty = runHook(env, null, { cwd: dir, input: "" });
  assert.equal(empty.status, 0);

  const noTranscript = runHook(env, { sessionId: SESSION_ID, cwd: dir }, { cwd: dir });
  assert.equal(noTranscript.status, 0);

  const missingFile = runHook(env, { sessionId: SESSION_ID, cwd: dir, transcriptPath: join(dir, "nope.jsonl") }, { cwd: dir });
  assert.equal(missingFile.status, 0);

  assert.equal(callsOf(env, "note").length, 0);
});

test("retention keeps the newest sessions per project", () => {
  const { dir, event } = setup();
  const memories = sessionMemories(6);
  const env = hookEnv(dir, {
    PALI_HOOK_KEEP_SESSIONS: "3",
    STUB_LIST: JSON.stringify(memories),
  });

  // A state file for a pruned session must go away so a resumed session can be captured again.
  const oldest = memories.at(-1);
  mkdirSync(join(env.PALI_HOOK_STATE_DIR, "stop"), { recursive: true });
  writeFileSync(join(env.PALI_HOOK_STATE_DIR, "stop", `${oldest.name}.json`), "{}");

  runHook(env, event, { cwd: dir });

  const lists = callsOf(env, "list");
  assert.equal(lists.length, 1);
  assert.equal(lists[0].args.scope, "test-project");
  assert.deepEqual(lists[0].args.tags_all, ["auto-capture"]);

  const forgotten = callsOf(env, "forget").map((call) => call.args.name);
  assert.deepEqual(forgotten, [
    "copilot-session-2026-10-22-old-session-2",
    "copilot-session-2026-10-21-old-session-1",
    "copilot-session-2026-10-20-old-session-0",
  ]);
  assert.ok(!forgotten.includes(callsOf(env, "note")[0].args.name), "the session just captured is never pruned");
  assert.equal(existsSync(join(env.PALI_HOOK_STATE_DIR, "stop", `${oldest.name}.json`)), false);
});

test("retention is skipped when disabled or nothing was captured", () => {
  const { dir, event } = setup();
  const disabled = hookEnv(dir, { PALI_HOOK_KEEP_SESSIONS: "0" });
  runHook(disabled, event, { cwd: dir });
  assert.equal(callsOf(disabled, "list").length, 0);

  const unchanged = hookEnv(tempDir(), { PALI_HOOK_KEEP_SESSIONS: "5" });
  runHook(unchanged, { sessionId: SESSION_ID, cwd: dir, transcriptPath: join(dir, "nothing.jsonl") }, { cwd: dir });
  assert.equal(callsOf(unchanged, "list").length, 0);
});

test("a failing list or forget never breaks the capture", () => {
  const { dir, event } = setup();
  const env = hookEnv(dir, { PALI_HOOK_KEEP_SESSIONS: "3", STUB_FAIL_TOOL: "list" });
  const result = runHook(env, event, { cwd: dir });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(callsOf(env, "note").length, 1, "capture succeeded before retention failed");
});
