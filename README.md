# Pali Memory for VS Code

A no-UI extension that wires the Pali memory server into VS Code. The server
crate is built from `pali/`

- registers the `pali` MCP server through VS Code's MCP server definition
  provider, so enabling the extension is enough — no command, install link, or
  manual configuration
- writes the user-level `~/.copilot/hooks/pali.json` once per machine, so the
  Copilot hooks recall project memories at session start, inject relevant
  memories per prompt, and capture a session digest when the agent stops

The hooks themselves live in `hooks/` and are unchanged from the standalone
Copilot hook scripts.

## Settings

| Setting          | Default | Purpose                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------- |
| `pali.path`      | `pali`  | Executable name or absolute path                                          |
| `pali.repoPath`  | empty   | Memory repository; empty uses `~/.memory-mcp`                             |
| `pali.remoteUrl` | empty   | Git remote (HTTPS/SSH URL or absolute local path); empty stays local-only |
| `pali.branch`    | `main`  | Branch used for push and pull                                             |
| `pali.scope`     | empty   | Hook memory scope; empty derives it from the git repo name                |
| `pali.modelPath` | empty   | Embedding model directory; empty uses the model the extension installed  |
| `pali.logLevel`  | `info`  | Log level for the extension, the MCP server, and the hooks                |

`remoteUrl` and `branch` are passed to the MCP server as `PALI_REMOTE_URL` and
`PALI_BRANCH`. `logLevel` (`debug`, `info`, `warn`, `error`, `off`) is passed
to the server as `RUST_LOG` and to the hooks as `PALI_HOOK_LOG_LEVEL`, so one
setting controls the whole project's verbosity. Extension and install log
lines land in the **Pali Memory** output channel.

### Automatic pali binary installation

If `pali` is not on your PATH and no custom `pali.path` is configured, the
extension offers to download a prebuilt binary from the project's GitHub
releases (`https://github.com/cderivan/memory-mcp`) and install it to its
private storage (`globalStorage`). Each release publishes one archive per
platform — `aarch64-apple-darwin.zip` (macOS, universal for arm64 and x64),
`pali.x86_64-pc-windows-msvc.zip` (Windows x86_64), and
`x86_64-unknown-linux-gnu.tgz` (Linux x86_64) — so no version lookup is needed.

- On first activation with no pali found, a modal notification offers
  **Download now** and **Later**.
- **Download now** fetches the archive for your platform, extracts the
  executable to `globalStorage/pali` (or `pali.exe` on Windows), makes it
  executable, updates `pali.path` to point there, and automatically restarts
  the MCP server so it uses the new binary. It then asks separately whether to
  download the embedding model, so neither download is forced.
- **Later** dismisses the prompt until the next extension activation; no
  download starts.

The repository is private, so downloads authenticate with the HTTPS token
stored via **Pali: Set HTTPS Token** (sent as a Bearer credential). A failed
download answers 401/403 and the error points at that command.

The bundle ships the binary compiled from `pali/` and prefers it over
every other source. The GitHub download is the fallback: an install made before
the binary was bundled, a platform the build did not cover, or a manual
**Pali: Install pali**.

Installing the binary also fetches the embedding model the server needs
(BGE-small-en-v1.5, about 130 MB) into `globalStorage/models/bge-small-en-v1.5`
from the same GitHub project. The server receives the directory as
`PALI_MODEL_DIR`. If the model download fails, an error suggests
`scripts/fetch-model.sh` and `PALI_MODEL_DIR` instead; the binary install
still succeeds.

If the download fails, an error message includes manual install instructions
with the release URL for your architecture. A prebuilt binary is also used if
one was previously downloaded (the extension caches it in `globalStorage`).

For a private `http(s)://` remote, run **Pali: Set HTTPS Token**; the token is
kept in VS Code's secret storage (the OS keychain), never in `settings.json`,
and handed to the server as `PALI_GIT_TOKEN` for the process lifetime only. It
is not written to the memory repository's git config, the logs, or MCP traffic.
**Pali: Clear HTTPS Token** removes it. For providers that need a specific
username, put it in the URL (`https://oauth2@gitlab.com/org/repo.git`);
otherwise `x-access-token` is used. Without a stored token, git's credential
helper or `~/.netrc` applies. A path remote syncs to a local or bare repository
with no authentication at all.

Hooks intentionally run local-only, so a slow remote cannot stall a session;
the long-running MCP server syncs on its next push/pull.

Uninstalling the extension runs its `vscode:uninstall` script, which removes
`~/.copilot/hooks/pali.json` (or the file under `PALI_HOOKS_DIR`). The hooks
point into the extension directory, so leaving the file behind would make
every hook event fail until it was deleted by hand. A file at that path that
the extension did not write is left untouched. Generated hook commands also
check for the script before running it and exit successfully when it is gone,
so a stale hook file cannot surface `MODULE_NOT_FOUND` stack traces.

## Scan and index a workspace

Two commands bootstrap the open folder into local retrieval artifacts under
`<workspace>/.pali/`, without touching the memory repository:

- **Pali: Scan Workspace** writes `.pali/scan.json`: the text-file inventory
  plus potential-secret findings by path and line (the matched values are
  never stored).
- **Pali: Index Workspace** embeds the scanned chunks into `.pali/index` (a
  usearch index plus `chunks.jsonl`), using the same embedding model the
  server loads. Long runs report progress and can be cancelled.

Both stream the CLI's tracing output to the **Pali Memory** channel and finish
with a one-line summary. The folder comes from the first workspace folder, so
open the checkout you want to bootstrap first.

## Build and install

The extension is the product; the server crate in `pali/` is compiled
as part of its build. `npm run build` runs Cargo, stages the binary at
`out/bin/pali`, then compiles the TypeScript.

```bash
npm run build       # crate + TypeScript, stages out/bin/pali
npm test            # extension unit tests
npm run test:vsix   # packages the VSIX and asserts its manifest
npm run package     # build + package pali-memory-0.3.0.vsix
code --install-extension pali-memory-0.3.0.vsix
```

On activation the extension registers the MCP server (VS Code may ask once to
trust it) and writes the hook file for the open workspace. Change a setting to
have both the hook file and the server definition refreshed. Reload the window
after installing, since VS Code only activates extensions it loaded at startup;
the "Pali Memory" output channel records the registration.

## Development

The icon is generated, not hand-drawn: `npm run icon` rewrites
`images/icon.png` byte for byte from `scripts/make-icon.js`.

## Publishing

```json
{
  "name": "postgres/connection-pool-timeout",
  "content": "Under burst load, check whether checkout_timeout is lower than the slowest query.",
  "tags": ["postgres", "debugging"],
  "scope": "my-api"
}
```

Then retrieve it by meaning or by the words it contains:

```json
{
  "query": "database connection failures during traffic spikes",
  "scope": "my-api",
  "limit": 5
}
```

For installation from source, Docker, a first-run walkthrough, and git sync,
continue with [Getting started](docs/getting-started.md).

## What ships today

Pali exposes the following MCP tools:

| Job                | Tools                                                |
| ------------------ | ---------------------------------------------------- |
| Write and organize | `remember`, `edit`, `move`, `forget`                 |
| Find and inspect   | `recall`, `read`, `list`                             |
| Synchronize        | `sync`                                               |
| Improve retrieval  | `mark_applied`, `batch_mark_applied`, `recall_stats` |

`recall` runs semantic vector search and BM25 lexical search, then combines the
ranked lists with reciprocal rank fusion. Results say whether they matched via
`semantic`, `lexical`, or `both`. Exact phrases receive lexical precedence even
when they are buried in long memories.

`recall` and `list` both accept `tags_all` and `tags_any` filters (exact,
case-sensitive tag matches) that apply before ranking or pagination, and `list`
can return full bodies with `fields: ["content"]`.

Scopes are hierarchical namespaces such as `my-project` or
`org/team/project`. Querying a scope includes that namespace, its descendants,
and global memories. Omitting a scope searches global memories only; passing
`all` explicitly searches every scope. Scopes organize retrieval. They are not
an access-control boundary.

See the [tool reference](docs/tools.md) for arguments, result contracts, scope
behavior, and recall feedback.

## How it fits together

```text
Agent ── stdio ──▶ pāli
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
               Markdown + git   BM25          local embeddings
               source of truth  lexical index HNSW vector index
                    │
                    ▼
                git remote
```

The Markdown repository is authoritative. Search indexes are derived from it and
can be rebuilt. Memory content is embedded locally; it leaves the machine only
when you deliberately sync the git repository to a remote.

Significant choices and their trade-offs live in the
[architecture overview](docs/architecture.md) and
[architecture decision records](docs/adr/), including
[hybrid retrieval](docs/adr/0038-bm25-hybrid-retrieval.md).

## Documentation

- [Getting started](./docs/getting-started.md) — install, run, connect, and sync
- [Client setup](docs/clients.md) — MCP configuration examples
- [Tool reference](docs/tools.md) — tool and retrieval contracts
- [Configuration](docs/configuration.md) — server flags, environment variables,
  and authentication
- [Deployment](docs/deployment.md) — running Pali in a container
- [Security](docs/security.md) — trust boundaries, credential handling,
  hardened deployment, and supply-chain controls
- [Architecture](docs/architecture.md) — storage, retrieval, sync, and
  operational boundaries
- [Documentation map](docs/README.md) — guides, architecture, and contributor
  references
  and pull requests
