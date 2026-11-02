# Pali documentation

The root [README](../README.md) explains why Pali exists and gets a new
user to a working server. This directory holds the detail needed after that
first success.

## Use Pali

- [Getting started](getting-started.md) — install, start the server, create a
  first memory, and configure git sync
- [Client setup](clients.md) — connect common MCP clients over stdio
- [Tool reference](tools.md) — tool arguments, retrieval behavior, scopes, and
  feedback
- [Configuration](configuration.md) — server flags, environment variables,
  authentication, and model settings
- [Deployment](deployment.md) — run the container image
- [Security](security.md) — trust boundaries, credentials, container hardening,
  and supply-chain controls

## Understand and change Pali

- [Architecture overview](architecture.md) — current storage, retrieval, sync,
  and operational boundaries
- [Architecture decision records](adr/) — binding design decisions and their
  trade-offs
- [Design artifacts](design/) — feature design documents produced before
  implementation
- [Roadmap](../ROADMAP.md) — open epics and completed work
- [Changelog](../CHANGELOG.md) — released changes

These Markdown files are arranged so they can become the source of a generated
documentation site without making that publishing machinery a prerequisite for
maintaining useful docs today.
