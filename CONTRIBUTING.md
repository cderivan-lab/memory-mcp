# Contributing

The repository-wide gates (fmt, clippy, docs, nextest, feature checks) are
described in [AGENTS.md](AGENTS.md) and run locally before a pull request. This
file covers the end-to-end suites, which need a real editor and are not part of
the canonical Rust suite.

## End-to-end tests

The suite runs against a real VS Code window and redirects every user-level
artifact it touches, so a run never writes the developer's `~/.copilot`
directory.

| Command | Suite | What it drives |
| --- | --- | --- |
| `npm run test:e2e` | `test/e2e/**/*.test.js` in a VS Code extension host | activation, hook and instructions installation, settings to MCP server definition |

### Configuration from `.env`

The launcher reads `.env` at the repository root. Start from the template:

```sh
cp .env.example .env
```

Every key is optional. A variable already exported by the shell or by CI takes
precedence over the file, so `PALI_HOOKS_DIR=/tmp/run npm run test:e2e` behaves
the same with or without a `.env`. Unset keys fall back to throwaway temp
directories.

| Variable | Purpose |
| --- | --- |
| `PALI_HOOKS_DIR` | Directory the extension writes its `pali.json` hook config into |
| `PALI_INSTRUCTIONS_PATH` | Instructions file activation installs |
| `PALI_SKILLS_DIR` | Directory activation installs the `pali-memory` skill into; the host suite's uninstall test deletes the installed copy, so keep this away from `~/.copilot/skills` |

Set these to fixed paths when a failing run's artifacts need to be inspected
afterwards; the default temp directories are removed when the launcher exits.
