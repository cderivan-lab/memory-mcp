# Security

## Security boundaries

Pali keeps inference and derived search indexes local. Memories remain
plaintext Markdown in the managed git repository, and their content leaves the
machine only when an operator deliberately configures and invokes git sync.

Namespace scopes organize retrieval; they are not access-control boundaries.
Pali does not authenticate MCP clients: it serves one session over the stdin
and stdout of the process that launches it, so its trust boundary is the OS
user identity. Anyone who can start the process can read and write the memory
repository under that identity, and any process that can attach to those pipes
is inside the trust boundary.

## Credentials and local files

GitHub tokens are resolved from `PALI_GITHUB_TOKEN`, an owner-readable
token file, or the system keyring. A deployment can inject a token through
the environment variable. The CLI does not accept tokens
as arguments, and credentials are not written to the memory repository. On
Unix, the file store creates its directory with mode `0o700` and token file
with mode `0o600`; Pali also sets process umask `0o077` before creating
files so group and other permissions are masked off by default.

Operators who cannot configure a credential helper may set `PALI_GIT_TOKEN`.
Pali reads it once per authentication attempt, passes it to libgit2 in memory,
and never writes it to the repository config, logs, spans, or MCP traffic; it
is not inherited by child processes. A token placed directly in
`PALI_REMOTE_URL` is different: Pali stores the remote URL in the repository's
git config, so prefer the variable. The VS Code extension keeps the token in
VS Code's secret storage (the OS keychain), never in `settings.json`, and hands
it to the server as the same variable.

Remote credentials are chosen by URL scheme. HTTP(S) remotes use the operator's
git credential configuration. `ssh://` and scp-like `user@host:path` remotes
use SSH: Pali tries the first default private key (`~/.ssh/id_ed25519`, then
`id_ecdsa`, then `id_rsa`) and falls back to the ssh-agent when libgit2
retries. Pali never reads or copies key material. A passphrase-protected key
requires a running agent; host-key verification follows libgit2/libssh2 and
the operator's SSH configuration.

## Input and repository safety

Memory names, content size, and nesting depth are validated at input
boundaries. Content is capped at 1 MiB and names at three path components.
Repository access rejects path traversal and symlink-based escapes, including
no-follow file opens on supported Unix targets. These checks protect the
managed repository; they do not turn scopes into authorization policy.

## Container hardening

The provided image runs as the non-root `pali` user (UID 1000). A container
orchestrator should add the controls the image alone cannot enforce:
`runAsNonRoot`, a read-only root filesystem, disabled privilege escalation,
all Linux capabilities dropped, and the `RuntimeDefault` seccomp profile.

The persistent memory repository and any writable caches still need writable
volumes with deployment-appropriate access controls. See
[Deployment](deployment.md) for operational notes.

## Supply-chain evidence and audit

No CI workflows are checked in; run the gates in
[CONTRIBUTING](../CONTRIBUTING.md) locally. `cargo deny check` enforces the
RustSec advisory, license, ban, and source policies declared in
[`deny.toml`](../deny.toml).

## Known limits

Pali currently has no application-layer client authentication,
authorization policy, or security audit log. Recall feedback is local retrieval
telemetry, not an audit trail. Protect the process, plaintext repository, token, and remote using controls
appropriate to their sensitivity.
