# Unreleased

## Changes

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
