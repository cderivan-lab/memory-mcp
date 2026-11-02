import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKFILL, callsOf, hookEnv, tempDir, user, writeTranscript } from "./helpers.mjs";

function makeRepo(root, name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), `${name}\n`);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=Test", "commit", "-qm", "init"], { cwd: repo });
  return repo;
}

function makeSession(sessionsDir, { id, cwd, createdAt, events }) {
  const dir = join(sessionsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\ncreated_at: ${createdAt}\nname: older session\n`);
  writeTranscript(dir, events);
}

function runBackfill(env, args) {
  const result = execFileSync(process.execPath, [BACKFILL, ...args], {
    env,
    encoding: "utf8",
    cwd: tmpdir(),
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result;
}

test("captures every existing session once, scoped to its own project", () => {
  const root = tempDir();
  const sessionsDir = join(root, "sessions");
  const alpha = makeRepo(root, "alpha-project");
  const beta = makeRepo(root, "beta-project");

  makeSession(sessionsDir, {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    cwd: alpha,
    createdAt: "2026-10-20T09:00:00.000Z",
    events: [user("Refactor the build script", "2026-10-20T09:00:00.000Z"), user("And run the tests", "2026-10-21T09:00:00.000Z")],
  });
  makeSession(sessionsDir, {
    id: "bbbbbbbb-1111-2222-3333-444444444444",
    cwd: beta,
    createdAt: "2026-10-22T09:00:00.000Z",
    events: [user("Why does the IPA fail to install?", "2026-10-22T09:00:00.000Z")],
  });

  const env = hookEnv(root, { PALI_SCOPE: undefined });
  const stdout = runBackfill(env, ["--sessions-dir", sessionsDir]);
  assert.match(stdout, /captured 2/);

  const notes = callsOf(env, "note");
  assert.equal(notes.length, 2);
  const byScope = Object.fromEntries(notes.map((call) => [call.args.scope, call.args]));
  assert.deepEqual(Object.keys(byScope).sort(), ["alpha-project", "beta-project"]);
  assert.match(byScope["alpha-project"].name, /^copilot-session-2026-10-20-aaaaaaaa/);
  assert.match(byScope["alpha-project"].content, /Refactor the build script/);
  assert.match(byScope["beta-project"].name, /^copilot-session-2026-10-22-bbbbbbbb/);
  assert.equal(byScope["alpha-project"].source, "copilot-backfill");
  assert.deepEqual(byScope["alpha-project"].tags, ["session", "auto-capture", "harness:copilot-cli"]);

  const rerun = runBackfill(env, ["--sessions-dir", sessionsDir]);
  assert.match(rerun, /captured 0, unchanged 2/);
  assert.equal(callsOf(env, "note").length, 2, "re-running the backfill is a no-op");
});

test("dry run reports the plan without writing", () => {
  const root = tempDir();
  const sessionsDir = join(root, "sessions");
  const repo = makeRepo(root, "gamma-project");
  makeSession(sessionsDir, {
    id: "cccccccc-1111-2222-3333-444444444444",
    cwd: repo,
    createdAt: "2026-10-24T09:00:00.000Z",
    events: [user("Tune the splash screen", "2026-10-24T09:00:00.000Z")],
  });

  const env = hookEnv(root, { PALI_SCOPE: undefined });
  const stdout = runBackfill(env, ["--sessions-dir", sessionsDir, "--dry-run"]);
  assert.match(stdout, /1 session transcript\(s\)/);
  assert.match(stdout, /plan .*gamma-project/);
  assert.equal(callsOf(env, "note").length, 0);
});

test("sessions without a user request and the --since cutoff are skipped", () => {
  const root = tempDir();
  const sessionsDir = join(root, "sessions");
  const repo = makeRepo(root, "delta-project");

  makeSession(sessionsDir, {
    id: "dddddddd-1111-2222-3333-444444444444",
    cwd: repo,
    createdAt: "2026-07-01T09:00:00.000Z",
    events: [{ type: "assistant.message", timestamp: "2026-07-01T09:00:00.000Z", data: { content: "nothing asked" } }],
  });
  makeSession(sessionsDir, {
    id: "eeeeeeee-1111-2222-3333-444444444444",
    cwd: repo,
    createdAt: "2026-01-02T09:00:00.000Z",
    events: [user("old work", "2026-01-02T09:00:00.000Z")],
  });

  const env = hookEnv(root, { PALI_SCOPE: undefined });
  const stdout = runBackfill(env, ["--sessions-dir", sessionsDir, "--since", "2026-06-01"]);
  assert.match(stdout, /captured 0/);
  assert.match(stdout, /too old 1/);
  assert.match(stdout, /empty 1/);
  assert.equal(callsOf(env, "note").length, 0);
});

test("backfill applies the retention limit after capturing", () => {
  const root = tempDir();
  const sessionsDir = join(root, "sessions");
  const repo = makeRepo(root, "epsilon-project");

  for (const [index, day] of ["2026-10-10", "2026-10-11"].entries()) {
    makeSession(sessionsDir, {
      id: `${index}fffffff-1111-2222-3333-444444444444`,
      cwd: repo,
      createdAt: `${day}T09:00:00.000Z`,
      events: [user(`work on ${day}`, `${day}T09:00:00.000Z`)],
    });
  }

  const memories = [
    { name: "copilot-session-2026-10-11-1fffffff-1111-2222-3333-444444444444", scope: "epsilon-project", created_at: "2026-10-11T09:00:00Z", tags: ["auto-capture"] },
    { name: "copilot-session-2026-10-10-0fffffff-1111-2222-3333-444444444444", scope: "epsilon-project", created_at: "2026-10-10T09:00:00Z", tags: ["auto-capture"] },
    { name: "copilot-session-2026-10-09-older", scope: "epsilon-project", created_at: "2026-10-09T09:00:00Z", tags: ["auto-capture"] },
  ];
  const env = hookEnv(root, { PALI_SCOPE: undefined, STUB_LIST: JSON.stringify(memories) });
  runBackfill(env, ["--sessions-dir", sessionsDir, "--keep", "1"]);

  const forgotten = callsOf(env, "forget").map((call) => call.args.name).sort();
  assert.deepEqual(forgotten, [
    "copilot-session-2026-10-09-older",
    "copilot-session-2026-10-10-0fffffff-1111-2222-3333-444444444444",
  ]);
});
