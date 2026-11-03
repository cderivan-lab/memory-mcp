# Unreleased

## Changes

- **Copilot hooks install once at the user level.** The extension now writes
  `~/.copilot/hooks/pali.json` (`%USERPROFILE%\.copilot\hooks\pali.json` on
  Windows) instead of a `.github/hooks/pali.json` copy in every workspace. One
  install covers every project, and `pali.scope` still separates memories per
  project. Existing per-workspace copies are left untouched.
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
