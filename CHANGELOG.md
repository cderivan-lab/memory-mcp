# Unreleased

## Changes

- **Windows SSH remotes now support ed25519 keys.** On Windows, libssh2
  is now built with the OpenSSL crypto backend (`libssh2-sys/openssl-on-win32`
  feature) instead of WinCNG, which lacks ed25519 support. The default
  `ssh-keygen` key type (ed25519) now works with SSH git remotes on Windows.
  See [ADR-0046](docs/adr/0046-ssh-git-remotes.md) for details.
- **Automatic HuggingFace model download on first run.** When the embedding
  model files are missing locally, Pali automatically downloads `config.json`,
  `tokenizer.json`, and `model.safetensors` (BGE-small-en-v1.5, ~130 MB) from
  HuggingFace Hub. Downloads are cached under `HF_HOME` (defaults to
  `~/.cache/huggingface`) and respect `HF_ENDPOINT` for self-hosted mirrors.
  Progress bars are suppressed in headless mode; status is logged via tracing.
  First-run latency is documented in `docs/getting-started.md`.
  - Resolves issue where users in air-gapped environments get a cryptic error.
  - `scripts/fetch-model.sh` remains the documented manual provisioning path.
  - ADR-0049 is superseded; ADR-0016 is updated to reference the restored
    `hf-hub` usage.
- **Private-repository downloads work with a stored token.** The browser
  download URL (`github.com/.../releases/download/...`) answers 404 for a
  private repository even with a valid token, so the installer now retries the
  release asset API, which is the documented authenticated path. The model
  archive is fetched from `raw.githubusercontent.com`, whose direct request
  keeps the Authorization header that the `github.com/.../raw/...` redirect
  dropped. A 404 now names the token requirement, and the release workflow
  publishes archives under the names the installer requests (`<target>.zip`,
  `<target>.tgz`).
- **New `pali.remoteSync` extension setting (default `false`).** When
  enabled, the MCP server is launched with `PALI_REQUIRE_REMOTE_SYNC=true`, so
  it pulls every repository from the remote before the startup index-freshness
  decision and refuses to start when `pali.remoteUrl` is not set. With the
  default `false`, the server starts without a startup pull and syncs only on
  an explicit `sync` tool call.
- **The VSIX ships only runtime files.** Dev-only entries (`.vscode-test.mjs`,
  `.freebuff/`, the hooks' `package.json`/lockfile, and the retired per-event
  hook sources and tests) are excluded; the extension ships
  `hooks/copilot-hooks.mjs` plus `hooks/pali-client.mjs`, which is all it runs.
- **Uninstalling the extension removes its Copilot hook config.** A
  `vscode:uninstall` script deletes `~/.copilot/hooks/pali.json` (or the file
  under `PALI_HOOKS_DIR`) when the extension is uninstalled. The hook file
  points into the extension directory, so a leftover copy made every hook
  event fail with `MODULE_NOT_FOUND` once that directory was gone. A file at
  the path that the extension did not write is left alone. Generated hook
  commands also check that `copilot-hooks.mjs` exists and exit successfully
  when it does not, so a stale hook file fails quietly instead of crashing
  every event with `MODULE_NOT_FOUND`. Unit tests now redirect
  `PALI_HOOKS_DIR` to a temp directory instead of overwriting the real hook
  file with a throwaway extension path, and an end-to-end test covers the
  uninstall/reinstall hook-file lifecycle.
- **New `Pali: Scan Workspace` and `Pali: Index Workspace` commands.** They run
  the CLI's `scan` and `index` subcommands against the first workspace folder,
  writing `.pali/scan.json` and `.pali/index` without touching the memory
  repository. `index` receives the same embedding model directory as the MCP
  server, and both stream tracing output to the **Pali Memory** channel with a
  cancellable progress notification and a one-line summary.
- **Copilot hooks install once at the user level.** The extension now writes
  `~/.copilot/hooks/pali.json` (`%USERPROFILE%\.copilot\hooks\pali.json` on
  Windows) instead of a `.github/hooks/pali.json` copy in every workspace. One
  install covers every project, and `pali.scope` still separates memories per
  project. Existing per-workspace copies are left untouched.
- **`Pali: Scan Repositories` command and scanner settings.** The command runs
  the CLI's `scan-repos` against the first workspace folder and writes
  `.pali/security-scan.json`, `.pali/scan-manifest.jsonl`, and
  `.pali/insights.json`. `pali.scanSaveMemories` (default `true`) commits the
  insight digest as the `codebase-insights` memory through `pali.repoPath` and
  `pali.scope`; `pali.scanBlame` (default `false`) adds per-line commit IDs;
  `pali.scanMaxFileBytes` (default 2 MiB) bounds included files.
- **A usable `pali.modelPath` no longer triggers the model download prompt.**
  Activation inspected only the extension's storage for the embedding model, so
  a user who provisioned the model elsewhere was asked to download it again on
  every activation. The installer now receives the configured path and skips
  both the activation offer and the post-install offer when the directory holds
  every required file; an unusable path still offers the download, because the
  server cannot start on it.
- **An unusable `pali.modelPath` is reported instead of failing the server.**
  Activation checks the directory for `config.json`, `tokenizer.json`, and
  `model.safetensors`; when any are missing (or the path does not exist or is
  not a directory), the extension shows an error naming the missing files and
  withholds the setting from the MCP server and the Copilot hooks, so the
  server starts on the installed model instead of failing later with an
  opaque startup error.
- **The VS Code extension gains a `pali.modelPath` setting.** Set it to a
  directory containing `config.json`, `tokenizer.json`, and
  `model.safetensors` to point the MCP server and the Copilot hooks at a
  model provisioned outside the extension's storage. When empty (the
  default), the auto-installed model is used, or the platform default when
  none is installed.
- **A single `pali.logLevel` setting (default `info`) controls the whole
  project's logging.** It is applied to the extension and installer log lines
  (now written to the **Pali Memory** output channel with a timestamp and
  level prefix instead of `console.log`), to the MCP server as a `pali`-scoped
  `RUST_LOG` filter, and to the Copilot hooks as `PALI_HOOK_LOG_LEVEL` so the
  hook log at `~/.pali-hooks/hook.log` stays consistent. Values: `debug`,
  `info`, `warn`, `error`, `off`.
- **Release assets are now per-platform archives.** The extension downloads
  the archive matching its platform from the GitHub Enterprise release —
  `aarch64-apple-darwin.zip` (macOS, universal for arm64 and x64),
  `pali.x86_64-pc-windows-msvc.zip` (Windows), or
  `x86_64-unknown-linux-gnu.tgz` (Linux) — extracts the `pali` executable, and
  removes the archive.
- **Binary and model downloads authenticate with the stored HTTPS token.**
  The repository is private, so downloads send the token from
  **Pali: Set HTTPS Token** as a Bearer credential. A 401/403 answer now
  names the token command in the error message.
- **The installer is Windows-aware.** Cached and bundled binaries resolve as
  `pali.exe` on Windows, where file mode carries no executable bit.
