# Deployment

Pali is a stdio MCP server for local use: the client launches `pali serve` and
exchanges JSON-RPC over the process's stdin/stdout. There is no listener, no
port, and no health endpoint. Run one process per concurrent client under your
own OS user — that identity is the trust boundary.

For the security model, see [Security](security.md).

## Install

Build the binary from source:

```bash
cargo build --release
install -m 0755 target/release/pali ~/.local/bin/pali
```

On macOS the replacement must give the path a *new* file. Rust binaries are only
linker ad-hoc signed, and overwriting the existing file in place (same inode)
invalidates that signature, so the next launch is killed by the kernel with
`SIGKILL (Code Signature Invalid)` — visible as `killed`, exit 137, and a
`pali-*.ips` report under `~/Library/Logs/DiagnosticReports`. Replace instead of
overwriting:

## Local build

```bash
docker build -t pali .
docker run -i --rm -v "$HOME/.memory-mcp:/data/repo" pali
```

The build pre-warms the model cache in an intermediate stage, and the runtime
image runs as the non-root `pali` user.

## Notes

- The image sets `PALI_REPO_PATH=/data/repo`, so mount a volume there.
- Model weights are memory-mapped from `HF_HOME`. Keep that cache on a volume
  dedicated to the process and do not mutate it while the server is running.
- For an offline environment, run `pali warmup` once with the same `HF_HOME`
  (or rely on the image's pre-warmed cache).
- The git repository is the backup: re-clone the remote to restore. The vector
  index is rebuilt from the repository on startup, and the in-RAM lexical index
  is rebuilt on every start.
