---
name: pali-memory

description: How Pali Memory works on this machine — the Pali Memory VS Code extension and the `pali` MCP server it registers. Use when the user says "store/remember this in a git repo", asks where memories live, how scopes or git sync work, wants per-project memory, or when recall, session capture, or Copilot hooks look broken.
---

# Pali Memory

This machine runs **Pali Memory**: a no-UI VS Code extension plus the `pali`
binary, a Rust MCP server that stores memories as Markdown files in a
git-backed repository. Retrieval is local — BGE-small-en-v1.5 embeddings (via
Candle) plus a BM25 lexical index, rank-fused with reciprocal rank fusion.
Nothing leaves the machine unless the memory repository is synced to a remote.

You (the agent) are already wired in through the MCP server. This skill covers
what happens without you, which tools to reach for, where the knobs are, and how
to debug it.

<!-- pali-tools: note remember recall read list edit move forget sync mark_applied batch_mark_applied recall_stats -->

The extension installs this file for the current user at
`~/.copilot/skills/pali-memory/SKILL.md` (`PALI_SKILLS_DIR` overrides the
directory) and refreshes it at activation, so it follows extension updates
instead of drifting from the product. At the same time it copies
`pali-memory.instructions.md` into `~/.copilot/instructions/`
(`PALI_INSTRUCTIONS_PATH` overrides the file for tests). The file carries
`applyTo: '**'` frontmatter and tells any Copilot agent to `recall` at task
start, store durable facts with `note`, and `read` full memories when a snippet
is not enough. It is a dedicated file, so the user's `copilot-instructions.md`
is never rewritten.

## Not this product

Older notes on this machine may describe Hindsight: banks, knowledge pages,
`hindsight_*` tools, `reflect`, a local daemon, or `npx @vectorize-io/...`
installs. None of that exists here. There is no server-side LLM extraction, no
bank concept, no page taxonomy, and no ingest command. If a user asks for one of
those, explain the Pali equivalent below instead of reaching for a tool that
will not exist.

## What happens automatically

### The MCP server

The extension registers the `pali` server through VS Code's MCP server
definition provider, so enabling the extension is enough — no `mcp.json` edit.
The definition runs `<binary> serve` with:

- `PALI_REPO_PATH` from `pali.repoPath` (default `~/.memory-mcp`),
- `PALI_REMOTE_URL`, `PALI_BRANCH`, and `PALI_REQUIRE_REMOTE_SYNC` from settings,
- `PALI_GIT_TOKEN` only when the remote is `http(s)://` and a token is stored,
- `PALI_MODEL_DIR` from `pali.modelPath` or the model the extension installed,
- `RUST_LOG` scoped to the `pali` crate, from `pali.logLevel`.

The binary is resolved in this order: the copy bundled in the extension
(`out/bin/pali`) → an explicit `pali.path` → `pali` on `PATH` → the
`globalStorage` download cache. With none present the extension offers to
download a release binary; the server definition is withheld until one exists.
Each client owns one stdio process; there is no shared listener.

### Copilot hooks

At activation the extension writes one user-level file,
`~/.copilot/hooks/pali.json` (`PALI_HOOKS_DIR` overrides the directory for
tests). It registers three events, each running `hooks/copilot-hooks.mjs` with
the current settings in the environment:

| Event                  | Timeout | What it does |
| ---------------------- | ------- | ------------ |
| `sessionStart`         | 30 s    | recalls up to 6 project memories and returns them as `additionalContext` |
| `userPromptTransformed`| 30 s    | recalls up to 5 memories for the prompt and appends them to `modifiedTransformedPrompt` |
| `agentStop`            | 60 s    | captures a deterministic session digest, then prunes old captures |

Details that matter in practice:

- **Scope.** Hooks derive the scope from the git top-level directory's basename
  (or the cwd basename outside git), sanitized to letters, numbers, `.`, `_`,
  and `-`, up to 10 `/`-separated components. `pali.scope` / `PALI_SCOPE`
  overrides it. A linked worktree resolves to its own top-level directory, so a
  differently named worktree gets its own scope; there is no main-checkout
  aliasing. **The MCP tools do not scope themselves** — pass the same scope
  explicitly (see [Scopes](#scopes)).
- **Session start** uses `limit: 6`, a 15 s budget, no distance cut, and a
  6,000-character block. It remembers what it injected for that session.
- **Per prompt** skips prompts shorter than 8 characters and prompts starting
  with `/` or `!`. It recalls with `limit: 5`, a 12 s budget, and drops results
  farther than `PALI_RECALL_MAX_DISTANCE` (default `0.45`; lexical-only hits
  carry `-1.0` and always pass). Memories already injected this session are
  skipped — that state lives in `~/.pali-hooks/sessions/`, expires after 12
  hours, and keeps the last 200 names. The block is capped at 2,500 characters;
  nothing is returned when it would be empty.
- **Session capture** runs only when the transcript names a user request. The
  digest is computed locally with no LLM call: up to 10 requests (400 chars
  each), 40 modified files, 12 commands, 5 failures, tool counts, and the final
  assistant message, capped at 16,000 characters. It is stored as
  `copilot-session-<YYYY-MM-DD>-<sessionId>` in the project scope with tags
  `session`, `auto-capture`, `harness:copilot-cli` and source
  `copilot-stop-hook`. A repeat stop on an unchanged transcript writes nothing
  (a hash is kept per name in `~/.pali-hooks/stop/`).
- **Retention** keeps the newest 20 `auto-capture` sessions per scope and
  forgets older ones (`PALI_HOOK_KEEP_SESSIONS`; `0` keeps everything).
  `PALI_HOOK_CAPTURE=0` disables capture; `PALI_HOOK_DISABLE=1` disables all
  three hooks.
- **Hooks are local-only.** Each invocation spawns a short-lived
  `pali serve` with no remote URL, issues only the calls its event needs (one
  recall for the first two events; capture plus retention calls on stop), and
  exits, so a slow remote cannot stall a session. The long-running MCP server
  performs the eventual push/pull on its next `sync`.
- **Failures never reach the host.** A killed binary, timeout, or malformed
  event is logged to `~/.pali-hooks/hook.log` and the hook exits quietly. The
  generated commands also skip a missing script, so a stale hook file after an
  uninstall does not produce `MODULE_NOT_FOUND`.

### Repository layout

The durable state is the memory repository (default `~/.memory-mcp`): one
Markdown file per memory with YAML frontmatter (id, name, scope, tags, source,
timestamps), committed to git. Derived state sits beside it in
`.memory-mcp-index/` — the scope-partitioned usearch vectors, `recall_log.sqlite`,
and index bookkeeping. The lexical BM25 index is in memory and rebuilt at every
startup; if a mutation fails it is marked degraded and recall falls back to
semantic-only until a background repair finishes. Indexes can always be rebuilt
from the Markdown.

## Storing things deliberately

When the user says "remember this" / "store this in a git repo":

- **The current conversation** is already captured by the Copilot `agentStop`
  hook as a digest — say so; no tool call is needed. The digest records the
  requests, files, commands, failures, and final message, not the full
  transcript or every tool output.
- **An external document, finding, or durable decision** → `note` with a short
  name, Markdown `content`, `tags`, `scope`, and an optional `source`. `note` is
  the canonical writer; `remember` is the same operation under its original
  name.
- **A new initiative or multi-step effort** → there is no initiative object.
  Store a normal memory (for example `initiatives/<slug>` with an
  `initiative` tag) and keep it current with `edit` as the plan changes. Do not
  create a second memory for a revised plan; edit the existing one.
- **Credentials, tokens, passwords, API keys, or secret-bearing URLs** → never.
  Memories are plaintext files in a git repository that may be pushed to a
  remote.
- Names may have up to three path components and are validated before they
  become file paths. Reusing an existing name in the same scope updates it.

To correct or retire something:

- `read` the memory first, verify against the code, git, or another source, then
  `edit` it in place with the corrected content (omit `tags` to keep them, or
  pass a new list to replace them). Put the evidence — file, commit, command
  output, exact value — in the content so the correction stands on its own.
- `forget` removes the file and vector permanently.
- `move` relocates a memory to another scope, optionally renaming it
  (`from_scope` defaults to global, `to_scope` is required). It is atomic: a
  failed create preserves the source.

Do not leave a known-stale memory in place and write a second, contradicting
one. Edit the record; the next session's recall and the prompt hook read
whatever is stored.

## Retrieving

- `recall(query, scope?, limit?, tags_all?, tags_any?)` — first stop for project
  questions. It runs embeddings and BM25, fuses the ranks, and returns
  `name`, `scope`, `tags`, a snippet of at most 500 characters, `truncated`,
  `content_length`, `match_type` (`semantic` | `lexical` | `both`), `distance`
  (cosine; `-1.0` means lexical-only, not a strong match), and a batch
  `recall_id`. `limit` defaults to 5; values above 100 are clamped.
- `read(name, scope?)` — the full body and metadata. Use it whenever `recall`
  says `truncated` and before acting on a decision, convention, or exact value.
- `list(scope?, limit?, cursor?, fields?, tags_all?, tags_any?)` — inventory and
  tag slices. Default limit 50, maximum 100, sorted by scope then name, keyset
  cursor bound to the same scope and tag filter, 24 KiB per page. `content` is
  opt-in via `fields`; a page never truncates a body.
- `recall_stats` / `pali recall-stats` — applied/maybe/not-applied counts by
  distance bucket, useful when recall quality is in question.

Tag filters are exact and case-sensitive and apply before ranking or
pagination. `tags_all` requires every tag, `tags_any` at least one, and both
together must both hold. Tags are filters, not part of the query text.

When memory informs an answer, credit it in one short line, e.g.
`🧠 From Pali memory (postgres/connection-pool-timeout): …`. Do not credit
memory that did not contribute, and do not present a recalled claim as current
state without checking the code when it is cheap to do so.

### Scopes

Scopes are hierarchical namespaces, not an access-control boundary:

- omit the scope or pass `global` → global memories only;
- `my-project` → that namespace, its descendants, and global memories;
- `org/team` → `org/team`, everything beneath it, and global;
- `all` → every scope (use deliberately).

Point tools (`note`, `read`, `edit`, `move`, `forget`) address one exact scope;
omitting theirs targets global. Because a default call searches only global,
**always pass the project scope for repository work**, using the same value the
hooks use: the git top-level basename (`git rev-parse --show-toplevel` →
`basename`), or the configured `pali.scope` when the user set one. When in
doubt, use `list(scope: "all")` to inspect existing scopes before writing
somewhere surprising.

`recall` with `scope: "all"` is the right way to look across projects when the
user is asking a cross-repo question; it is the wrong default for an ordinary
project question because it can surface unrelated decisions.

### Recall feedback

Every recall returns a `recall_id`. After deciding whether results helped, call:

- `mark_applied(recall_id, memory, verdict, application?, confidence?)` for one
  result, or
- `batch_mark_applied(verdicts: [...])` for several in one transaction.

`verdict` is `applied`, `maybe`, or `not_applied`; confidence defaults to
`medium`. This is local SQLite telemetry used to calibrate thresholds — it is
not written to the memory repository and does not sync. Saving a document is
not a recall and needs no verdict.

## Git sync and sharing

Pali works with no remote. Local-only is the default and hooks never sync.

- **Remote URL** accepts HTTPS, SSH (`ssh://` or `git@host:path`), or an
  absolute path to a local/bare repository. In VS Code set `pali.remoteUrl`; for
  another MCP client pass `--remote-url` or `PALI_REMOTE_URL`.
- **Authentication:** SSH uses the default key or agent. HTTPS uses git's
  credential helper or `~/.netrc`, or `PALI_GIT_TOKEN` for that process only.
  The extension's **Pali: Set HTTPS Token** stores the token in VS Code secret
  storage (OS keychain), never `settings.json`, and passes it as
  `PALI_GIT_TOKEN` only for `http(s)` remotes. **Pali: Clear HTTPS Token**
  removes it. Tokens are never written to git config, logs, or MCP traffic.
- **`sync(pull_first?)`** pulls before pushing by default, resolves file
  conflicts using the `updated_at` timestamps in memory frontmatter, and logs
  each resolution as a warning. With no remote it reports local-only and does
  nothing.
- **`pali.branch`** (`PALI_BRANCH`, default `main`) is the branch used for both
  directions.
- **`pali.remoteSync`** (`PALI_REQUIRE_REMOTE_SYNC`, default `false`) makes the
  server pull every repository *before* deciding startup index freshness, and
  refuses to start when no remote is configured. Enable it when a stale checkout
  must never be served; leave it off for offline-first use.

### Per-scope remotes

The TOML config file lives in the platform config directory —
`~/.config/memory-mcp/config.toml` on Linux,
`~/Library/Application Support/memory-mcp/config.toml` on macOS,
`%APPDATA%\memory-mcp\config.toml` on Windows — or at `PALI_CONFIG`; an empty
path disables loading. It routes scopes to dedicated repositories:

```toml
[[remotes]]
scope = "work"
url = "git@github.com:org/work-memories.git"
path = "~/.memory-mcp-work"   # optional
branch = "main"               # optional, defaults to the server branch

[[remotes]]
scope = "org/team"
url = "https://example.com/team-memories.git"
```

The default path is `~/.memory-mcp-<scope>` with `/` encoded as `%2F`, so
`org/team` and `org-team` never collide. Every mapped branch is validated at
load time. Scope-to-repo routing is topology, not authorization.

## Configuration

### VS Code settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `pali.path` | `pali` | Executable name or absolute path; updated to the resolved path after an install |
| `pali.repoPath` | empty | Memory repository; empty uses `~/.memory-mcp` |
| `pali.remoteUrl` | empty | Git remote (HTTPS/SSH/local path); empty stays local-only |
| `pali.remoteSync` | `false` | Pull everything before startup and require a remote |
| `pali.branch` | `main` | Branch for push and pull |
| `pali.scope` | empty | Hook scope; empty derives it from the git repository name |
| `pali.modelPath` | empty | Embedding model directory; empty uses the installed model |
| `pali.logLevel` | `info` | `debug`/`info`/`warn`/`error`/`off`, for extension, server, and hooks |
| `pali.checkUpdates` | `true` | Prompt when a newer release binary exists (startup check is skipped for the bundled binary) |
| `pali.scanBlame` | `false` | Record git-blame commit IDs and line numbers during Scan |
| `pali.scanMaxFileBytes` | 2 MiB | Largest file included by Scan |
| `pali.scanSaveMemories` | `true` | Save the scan's insight digest as a memory |

Changing any `pali.*` setting rewrites the hook file and asks VS Code to
re-read the server definition. A semantic model change still needs a server
restart; the settings change fires that request, but an already-running stdio
process keeps its old environment until VS Code starts the next one.

### Server flags and environment

Run `pali serve --help` for the authoritative list. The common ones:

| Flag | Env | Default |
| --- | --- | --- |
| `--repo-path` | `PALI_REPO_PATH` | `~/.memory-mcp` |
| `--config` | `PALI_CONFIG` | platform config dir (see [Per-scope remotes](#per-scope-remotes)) |
| `--remote-url` | `PALI_REMOTE_URL` | unset (local-only) |
| `--branch` | `PALI_BRANCH` | `main` |
| `--require-remote-sync` | `PALI_REQUIRE_REMOTE_SYNC` | `false` |
| `--embed-timeout-secs` | `PALI_EMBED_TIMEOUT_SECS` | `30` |
| `--embed-queue-size` | `PALI_EMBED_QUEUE_SIZE` | `64` |
| `--recall-log-busy-timeout` | `PALI_RECALL_LOG_BUSY_TIMEOUT` | `5` |
| — | `PALI_MODEL_DIR` | model resolution order below |
| — | `PALI_GIT_TOKEN` | unset (git credentials) |

`MEMORY_MCP_*` variables are rejected with an error naming the `PALI_*`
replacement; unknown legacy-prefixed variables are reported by count only. A
server that suddenly fails at startup after an upgrade is usually this — update
the environment atomically rather than adding an alias.

### Embedding model

Pali computes embeddings locally with BGE-small-en-v1.5 (384 dimensions) and
never downloads the model itself. Files are resolved from `PALI_MODEL_DIR`,
then `<cwd>/models/bge-small-en-v1.5`, then the platform data directory. The
extension offers to install it into `globalStorage/models/` and exports
`PALI_MODEL_DIR`; `scripts/fetch-model.sh` and `pali warmup` cover manual
setups. Without usable model files the server cannot start, and a directory
missing `config.json`, `tokenizer.json`, or `model.safetensors` is reported and
ignored rather than failing opaquely.

### Hook environment

The extension bakes the current values into each hook command, so these are
usually set for you. They are still useful for a manual or non-extension hook
setup:

| Variable | Default | Effect |
| --- | --- | --- |
| `PALI_BIN` | `pali` | Binary to spawn |
| `PALI_REPO_PATH` | empty | Repository override |
| `PALI_SCOPE` | empty | Scope override |
| `PALI_HOOK_DISABLE` | unset | `1` disables every hook |
| `PALI_HOOK_CAPTURE` | on | `0` disables `agentStop` capture (retention with it) |
| `PALI_HOOK_KEEP_SESSIONS` | `20` | Captures kept per scope; `0` keeps all |
| `PALI_RECALL_MAX_DISTANCE` | `0.45` | Prompt-hook distance cut; `0` keeps every ranked hit |
| `PALI_HOOK_LOG_LEVEL` | `info` | Hook log threshold |
| `PALI_HOOK_LOG_FILE` | `~/.pali-hooks/hook.log` | Hook log path |
| `PALI_HOOK_STATE_DIR` | `~/.pali-hooks` | State root for sessions and captured hashes |

`PALI_HOOKS_DIR` is different: it only redirects where the extension writes
`pali.json`, and the hooks do not read it. `PALI_INSTRUCTIONS_PATH` redirects
the single instructions file the extension edits, not a directory.

## Workspace scan and index

These are separate from the memory tools: they write local artifacts under
`<workspace>/.pali/` and never touch the memory repository (except
`--save-memories`).

- `pali scan` (VS Code: **Pali: Scan Workspace**) — file inventory and potential
  secret findings by path and line, never the matched value. In a git
  repository it also writes `security-scan.json`, `scan-manifest.jsonl`, and
  `insights.json` (languages, areas, largest files, TODO/FIXME counts, test
  ratio). `--blame` records only commit IDs and line numbers. Files that look
  sensitive (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, …) are listed but
  never chunked.
- `pali index` (VS Code: **Pali: Index Workspace**) — embeds scanned chunks into
  `.pali/index`; needs the model.
- `pali dataset --output out.jsonl` — scanned chunks as JSONL.
- `pali scan --save-memories --scope <name>` — commits the insight digest as one
  `codebase-insights` memory, so later sessions can recall the layout. This is
  the one path that writes to the memory repository; it is refused outside git.

`--limit N` bounds a sample deterministically (files are sorted first).

## Install, update, uninstall

**VS Code:** install the `pali-memory` VSIX and reload the window. Activation
registers the server, writes the hook file, resolves or offers to install the
binary, and offers the ~130 MB model download separately. Commands:

- **Pali: Install pali** — download/install the binary for this platform.
- **Pali: Update pali** — force a release check.
- **Pali: Restart MCP Server** — re-resolve the binary/model and ask VS Code
  to restart.
- **Pali: Set HTTPS Token** / **Pali: Clear HTTPS Token** — release downloads
  and HTTPS remotes.

The VSIX ships a binary built from `pali/`, so the release download is the
fallback for an unbundled platform or a manual install. A private GitHub
repository answers 401/403 without a token, and the error points at the token
command.

**Manual MCP client:** configure `command: "pali", args: ["serve"]`, fetch the
model with `scripts/fetch-model.sh`, and verify with `pali warmup`. From source:
`cargo install --path pali`.

**Uninstall:** the extension's `vscode:uninstall` script removes
`~/.copilot/hooks/pali.json` only when the extension wrote it, removes the
installed skill at `~/.copilot/skills/pali-memory/SKILL.md` only when it still
matches the shipped copy, and removes
`~/.copilot/instructions/pali-memory.instructions.md` only when it still
matches the shipped copy. A file shared with another tool or a hand-edited
skill or instructions file is left alone. Memories, the repository, and
`~/.pali-hooks/` are not removed.

## Diagnostics

| What | Where |
| --- | --- |
| Extension, installs, scan/index output | **Pali Memory** output channel |
| Hook activity and failures | `~/.pali-hooks/hook.log` (0600, rotates at 1 MB to `hook.log.1`) |
| Server logs | stderr; `RUST_LOG`, default `pali=info,warn` |
| Injection and capture state | `~/.pali-hooks/sessions/`, `~/.pali-hooks/stop/` |
| Vector index and recall telemetry | `<repo>/.memory-mcp-index/`, `recall_log.sqlite` |
| Recall quality | `recall_stats` tool or `pali recall-stats` |

Set `pali.logLevel` to `debug` (or `PALI_HOOK_LOG_LEVEL=debug`) first when
diagnosing a recall miss or a sync failure; it drives all three components.
Hook logs record one line per injection (`injected N memories`), capture,
prune, and any swallowed failure. At `info`, a successful hook with nothing to
say is silent by design.

### When memory seems missing

Work through the layers; each fails independently and quietly:

1. **Was a hook supposed to run?** `PALI_HOOK_DISABLE`, `PALI_HOOK_CAPTURE=0`, a
   prompt under 8 characters, or a `/command` produce no injection or capture
   by design. Check `hook.log` for `sessionStart <scope>` / `prompt <scope>`.
2. **Was the scope right?** Hooks use the git top-level basename; the agent must
   pass the same scope. A session started in a subdirectory outside git writes
   to that directory's name. Inspect with `list(scope: "all")`.
3. **Is there anything to recall?** A fresh scope is empty until a capture or a
   `note`. There is no seed and no survey; `pali scan --save-memories` is the
   bootstrap. A prompt result farther than `PALI_RECALL_MAX_DISTANCE` is
   dropped even though it was ranked; session start has no such cut.
4. **Did the server start?** Without a binary the server definition is not
   registered and every hook spawn fails into `hook.log`; with unusable model
   files it is registered but fails at startup. Check the output channel for
   `pali: using binary ...` and the model path.
5. **Is the index degraded?** A failed lexical update is logged, and recall
   serves semantic-only until repair converges. A `debug` server log and
   `recall_stats` show whether recalls are being served and logged at all.
6. **Was the memory correct?** `read` it. A digest records what happened, not
   that it was right; a stale decision stays stale until `edit`ed.

A session that was already running contains no injection from before the
extension was enabled — start a new session rather than expecting a retroactive
prompt injection. After an install or a settings change, a window reload is the
reliable way to pick up a new server definition.

### Resetting memory

- **One memory:** `forget` by name and scope.
- **A project's captures:** `forget` each `copilot-session-*`, or lower
  `PALI_HOOK_KEEP_SESSIONS` and let retention prune them.
- **Everything:** stop the server and delete the repository directory
  (`~/.memory-mcp`, or your `pali.repoPath`). It contains the Markdown history,
  the index, and the recall log. To re-capture sessions that were pruned, also
  remove `~/.pali-hooks/stop/` — a retained hash otherwise says "already
  stored" for a name that no longer exists.

Deleting the repository does not remove embedded memories from an already
running server's in-memory index; restart it before treating the reset as
complete.
