# Configuration

Server options are available as command-line flags and environment variables.
Run `pali serve --help` against your installed version for the complete,
authoritative list.

Pali 0.19.0 replaces the former `MEMORY_MCP_*` prefix with `PALI_*` without
compatibility aliases. A process started with a known former variable exits
with an error naming its replacement instead of silently using a default;
unknown legacy-prefixed variables are reported only by count. Upgrade the
binary and its environment atomically. To roll back, restore both the
pre-0.19 artifact and its former environment names.

## Server

| Flag | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `--repo-path` | `PALI_REPO_PATH` | `~/.memory-mcp` | Git-backed memory repository |
| `--config` | `PALI_CONFIG` | platform config dir (see below) | TOML config file for per-scope remote mapping; empty string disables config loading |
| `--remote-url` | `PALI_REMOTE_URL` | unset | Git remote: HTTPS/SSH URL or an absolute path to a local repository; omit for local-only mode |
| `--branch` | `PALI_BRANCH` | `main` | Branch used for push and pull |
| `--require-remote-sync` | `PALI_REQUIRE_REMOTE_SYNC` | `false` | Pull every repository before startup index freshness is decided; requires `--remote-url` |
| `--recall-log-busy-timeout` | `PALI_RECALL_LOG_BUSY_TIMEOUT` | `5` | SQLite lock wait in seconds |

The VS Code extension exposes `--require-remote-sync` as `pali.remoteSync`
(default `false`) and passes it to the server as `PALI_REQUIRE_REMOTE_SYNC`.
When enabled, the server pulls every repository before the startup
index-freshness decision and refuses to start when `pali.remoteUrl` is empty.

The config file is `memory-mcp/config.toml` under the platform's config
directory: `~/.config/memory-mcp/config.toml` on Linux,
`~/Library/Application Support/memory-mcp/config.toml` on macOS, and
`%APPDATA%\memory-mcp\config.toml` on Windows. `PALI_CONFIG` overrides it; an
empty value disables config loading.

`pali serve` serves one MCP session over stdin/stdout. Diagnostics stay on
stderr so stdout carries only MCP frames. Each concurrent client needs its own
process.

## Logging

The server's tracing filter is `RUST_LOG` (see
[tracing requirements](../design/tracing/requirements.md)). The default is
`pali=info,warn`: info-level handler spans plus warnings, with subsystem
internals at `debug`.

The VS Code extension exposes the same knob as `pali.logLevel`
(`debug`, `info`, `warn`, `error`, `off`, default `info`) and applies it in
three places:

- the MCP server environment as `RUST_LOG`, so the server's stderr matches;
- the Copilot hook commands as `PALI_HOOK_LOG_LEVEL`, so the hook log at
  `~/.pali-hooks/hook.log` matches;
- the extension's own log lines, which land in the **Pali Memory** output
  channel with a timestamp and level prefix.

Setting `pali.logLevel` to `debug` is the usual first step when diagnosing
recall misses or git sync problems. Security-relevant events (invalid inputs,
rejected repository paths) are logged at `warn` or higher regardless of level,
and no log line ever carries a token, credential, or memory content.

## Embedding work

| Flag | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `--embed-timeout-secs` | `PALI_EMBED_TIMEOUT_SECS` | `30` | Maximum time for one embedding call |
| `--embed-queue-size` | `PALI_EMBED_QUEUE_SIZE` | `64` | Bounded embedding-worker queue |
| `--no-model-download` | `PALI_NO_MODEL_DOWNLOAD` | `false` | When true, skip automatic download and fail if model files are missing |

### HuggingFace Hub configuration

The automatic model download uses the [hf-hub](https://docs.rs/hf-hub) crate with
environment variables documented there:

- `HF_HOME` — cache directory for downloaded model files (default: `~/.cache/huggingface`)
- `HF_ENDPOINT` — override the Hub API URL (useful for self-hosted mirrors)

## Git credentials

Pali does not store credentials. HTTPS remotes use git's own credential
acquisition — configured credential helpers or a `~/.netrc` entry — unless
`PALI_GIT_TOKEN` is set, in which case that token authenticates HTTPS remotes
for this process only. The token is never written to the repository's git
config, the logs, or MCP traffic.

When `PALI_GIT_TOKEN` is used, the username comes from the remote URL if one is
present (`https://oauth2@gitlab.com/org/repo.git`); otherwise Pali sends
`x-access-token`, which is what GitHub expects for personal access tokens. Set
the variable to an empty string to fall back to the credential helper.

`PALI_REMOTE_URL` also accepts an absolute path to a local or bare repository.
Git resolves path remotes directly, with no authentication.

The CLI has no `auth` subcommand: it exposes `serve`, `warmup`,
`recall-stats`, `scan`, `index`, and `dataset`. There is no token file or
keyring store — a token comes from `PALI_GIT_TOKEN` or from git's own
credential configuration.

## Embedding model

Pali computes embeddings locally with Candle and BGE-small-en-v1.5
(384 dimensions). On first run, if the model files are missing locally,
Pali automatically downloads them from HuggingFace Hub. The files are cached
under `HF_HOME` (defaults to `~/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5`)
and respect the `HF_ENDPOINT` environment variable for self-hosted Hub mirrors.
Download progress bars are suppressed for headless operation; status is logged via tracing.

Model files are resolved from, in order:

1. `PALI_MODEL_DIR` — a directory containing `config.json`, `tokenizer.json`,
   and `model.safetensors`. The VS Code extension exports this from the
   `pali.modelPath` setting (or, when that is empty, from the model it
   auto-installed), so setting `pali.modelPath` in VS Code is the
   configuration-side equivalent. A directory missing any of the files is
   reported in an error notification and ignored, so the server starts on the
   model the extension installed instead of failing with an opaque error.
2. `<current-working-directory>/models/bge-small-en-v1.5` — the VS Code
   extension starts the server from the workspace folder, so a model vendored
   in the repository (or fetched there) is found without extra configuration
3. The platform's local data directory, e.g. `~/.local/share/memory-mcp/models/bge-small-en-v1.5`
   on Linux, `~/Library/Application Support/memory-mcp/models/bge-small-en-v1.5`
   on macOS, or `%LOCALAPPDATA%\memory-mcp\models\bge-small-en-v1.5` on
   Windows

`scripts/fetch-model.sh` writes to the same location by default (run it from
the workspace root to fetch into `./models/bge-small-en-v1.5`), or to
`$PALI_MODEL_DIR` if set.

A dedicated worker thread owns the embedding engine. The queue is bounded, and
a timed-out request does not permanently wedge the worker.
