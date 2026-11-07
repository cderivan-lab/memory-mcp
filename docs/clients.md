# Client setup

Pali speaks MCP over stdio: the client launches `pali serve` as a subprocess and
exchanges newline-delimited JSON-RPC on stdin/stdout. The process is the
session — stdout carries only MCP frames, logs go to stderr, and the client ends
the session by closing stdin. Concurrent clients each need their own process.

Client configuration formats evolve independently from Pali. Treat these
examples as starting points and consult the client documentation when a current
release rejects a field or location.

## Claude Code

Add to `~/.claude.json` or a project's `.mcp.json`:

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

## Cursor

Add to `.cursor/mcp.json` for a project or `~/.cursor/mcp.json` globally:

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

## Visual Studio Code with GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "memory": {
      "type": "stdio",
      "command": "pali",
      "args": ["serve"]
    }
  }
}
```

Visual Studio Code uses `servers` as the root key rather than `mcpServers`.

The [Pali Memory extension](../README.md#install) does this
setup for you: it registers the server with your configured `pali.remoteUrl`
and `pali.branch` when VS Code activates it, and writes the user-level
`~/.copilot/hooks/pali.json` for the Copilot hooks. It also copies
`~/.copilot/instructions/pali-memory.instructions.md`. The extension also passes
`pali.logLevel` (default `info`) to the server as `RUST_LOG` and to the hooks
as `PALI_HOOK_LOG_LEVEL`, exports `pali.modelPath` (or the model it
auto-installed) as `PALI_MODEL_DIR` to the server and the hooks, and writes
its own log lines to the **Pali Memory** output channel.

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

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

## Continue

Add `.continue/mcpServers/memory.yaml`:

```yaml
mcpServers:
  - name: memory
    command: pali
    args:
      - serve
```

## Options

Add `--repo-path`, `--remote-url`, and related flags to the `args` array as
needed. See [Configuration](configuration.md) for the shared options.
