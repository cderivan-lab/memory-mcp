# Getting started

This guide takes Pali from installation to a first successful recall.

## Install

Each release publishes the server as `pali-<target>` binaries for Linux x86_64
and macOS, plus the VS Code extension as one VSIX per platform, on the project's
releases page. The crate is not published to a registry.

Or build the current source:

```bash
git clone https://github.com/cderivan/memory-mcp.git
cd pali
cargo install --path .
```

## Connect an MCP client

Pali serves MCP over stdio: the client launches `pali serve` and writes
JSON-RPC to its stdin, reading replies from its stdout. Memories are stored in
`~/.memory-mcp`.

```json
{
  "mcpServers": {
    "memory": {
      "command": "pali",
      "args": ["serve"]
    }
  }
}
```

The process owns a single connection. Logs go to stderr, and closing stdin ends
the session, so each concurrent client starts its own process.

Pali does not download its embedding model automatically — fetch
BGE-small-en-v1.5 (about 130 MB) once before the first `pali serve`:

```bash
scripts/fetch-model.sh
pali warmup  # verifies the files load correctly
```

`scripts/fetch-model.sh` writes to the default model directory (or
`$PALI_MODEL_DIR` if set). See [Configuration](configuration.md) for the
resolution order and how to point at a model fetched elsewhere.

To use a different repository location, add the flag to the client's args:

```json
{
  "mcpServers": {
    "memory": {
      "command": "pali",
      "args": ["serve", "--repo-path", "/path/to/memories"]
    }
  }
}
```

See [Configuration](configuration.md) for the complete runtime surface and
[Client setup](clients.md) for client-specific locations and field names.

## Bootstrap a workspace

`pali scan`, `pali index`, and `pali dataset` turn a checkout into local
retrieval artifacts without touching the memory repository. All three write
under the workspace's `.pali/` directory (override with `--artifacts`), which
later scans skip:

```bash
pali scan                        # .pali/scan.json: inventory and secret findings
pali index                       # .pali/index: usearch index plus chunks.jsonl
pali dataset --output out.jsonl  # JSONL chunks for training or evaluation
```

`scan` reads text files up to 2 MiB, skips dependency and build directories,
and reports potential private keys, AWS access keys, GitHub tokens, and Slack
tokens by path and line — never the value. Files that commonly hold
credentials (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, and similar) are
listed, but `index` and `dataset` never chunk their contents. `--limit N`
bounds a sample; files are sorted first, so the prefix is deterministic.
`index` needs the embedding model provisioned with `scripts/fetch-model.sh`.

`pali scan` is git-aware: when the workspace root is a git repository it scans
that repository (nested repositories are not followed), lists its tracked and
untracked-but-not-ignored files, and writes
`.pali/security-scan.json`, `.pali/scan-manifest.jsonl`, and
`.pali/insights.json`: repository, path, language, HEAD commit, content hash,
recent commit subjects, and — with `--blame` — per-line commit IDs. The
insights are deterministic counts and paths (language mix, top-level areas,
largest files, TODO/FIXME markers, test-file ratio, project files), never model
output or file content. A file whose path or contents look sensitive is
excluded whole rather than redacted, and findings name the rule, path, and line,
never the matched value.

A plain directory gets the file and secret report from the workspace scanner
instead; `--save-memories` is refused there because there is no digest to
commit.

`--save-memories` also stores the insight digest as one `codebase-insights`
memory in the pali memory repository (default `~/.memory-mcp`), so later agent
sessions can recall how the project is laid out. `--scope` defaults to the
workspace directory name.

## Install the VS Code extension

In VS Code, the [Pali Memory extension](../README.md#install)
registers the server for you: enabling the extension adds a `pali` MCP server
built from the `pali.binPath`, `pali.repoPath`, `pali.remoteUrl`,
`pali.branch`, and `pali.modelPath` settings, then starts it on demand. It
also writes the user-level
`~/.copilot/hooks/pali.json` once per machine, so Copilot recalls project
memories at session start and captures a digest when the agent stops. VS Code may ask once to trust
the server.

## Store and retrieve a memory

Ask the connected agent to call `remember`:

```json
{
  "name": "postgres/connection-pool-timeout",
  "content": "Under burst load, check whether checkout_timeout is lower than the slowest query.",
  "tags": ["postgres", "debugging"],
  "scope": "my-api"
}
```

Then ask it to call `recall`:

```json
{
  "query": "database connection failures during traffic spikes",
  "scope": "my-api",
  "limit": 5
}
```

`recall` combines semantic and keyword rankings. Each result reports its
`match_type`, a content snippet, and whether the snippet was truncated. Use
`read` before acting on a truncated result.

## Configure git sync

Pali works without a remote. To share the repository across machines,
configure a remote URL when starting the server:

```bash
PALI_REMOTE_URL=https://github.com/you/my-memories.git \
pali serve
```

`ssh://` and scp-like `git@host:path` remotes work too and need no token:
Pali uses a default key in `~/.ssh` or the running ssh-agent.

For a private HTTPS remote, configure git credentials the usual way — a
credential helper or a `~/.netrc` entry — or set `PALI_GIT_TOKEN` to a personal
access token. Pali does not store tokens either way. The remote may also be an
absolute path to a local or bare repository.

The connected agent can then call the `sync` MCP tool. There is no standalone
`pali sync` CLI subcommand.

For per-scope remotes, continue with [Configuration](configuration.md).
