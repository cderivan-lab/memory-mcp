# Spec Delta: ssh-remote-sync

## Purpose

Defines how the memory server authenticates to SSH git remotes: which
private-key types must work, which credential sources are consulted, and
how authentication failures surface — consistently across platforms, so a
token-free SSH sync path is usable on every supported OS.

## ADDED Requirements

### Requirement: Ed25519 key authentication on all supported platforms

The server SHALL authenticate to SSH git remotes using an operator-provided
ed25519 private key, on every supported platform including Windows. The key
is read from the operator's filesystem or agent; the server SHALL NOT store,
copy, or modify key material.

#### Scenario: ed25519 default key file on Windows

- GIVEN an SSH remote (`ssh://` or scp-like `git@host:path`) and a
  passphrase-less `~/.ssh/id_ed25519` registered with the remote host
- WHEN the server pulls or pushes over that remote on Windows
- THEN the SSH session authenticates successfully and the transfer completes

#### Scenario: ed25519 default key file on Linux and macOS

- GIVEN the same key setup as above
- WHEN the server pulls or pushes over that remote on Linux or macOS
- THEN the SSH session authenticates successfully and the transfer completes

### Requirement: Credential source fallback order

The server SHALL attempt SSH credentials in a fixed order: (1) the first
existing default private key file (`~/.ssh/id_ed25519`, then `id_ecdsa`,
then `id_rsa`), and (2) the running ssh-agent when `SSH_AUTH_SOCK` is set,
used on the transport's retry after a rejected attempt.

#### Scenario: Agent-held key when no usable default key file

- GIVEN no default key file present, an ssh-agent running with the
  operator's ed25519 key, and `SSH_AUTH_SOCK` set in the server environment
- WHEN the server pulls or pushes over an SSH remote
- THEN authentication succeeds using the agent-held key

#### Scenario: No credential source available

- GIVEN no default key file and no `SSH_AUTH_SOCK`
- WHEN the server attempts an SSH pull or push
- THEN the operation fails with an authentication error (not a
  credential-setup error) and the error message indicates that no SSH
  credential is available

### Requirement: Key-type support matches modern defaults

The SSH transport SHALL support the key types produced by current
`ssh-keygen` defaults (ed25519 and RSA) on all supported platforms, so that
keys generated with recent OpenSSH versions work without operator
intervention.

#### Scenario: RSA key on Windows

- GIVEN an SSH remote and a passphrase-less `~/.ssh/id_ed25519` absent but a
  registered `~/.ssh/id_rsa` present
- WHEN the server pulls or pushes over that remote on Windows
- THEN the SSH session authenticates successfully using the RSA key

#### Scenario: Unsupported key type fails with a transport error

- GIVEN a private key type the transport cannot sign with
- WHEN the server attempts an SSH pull or push
- THEN the operation fails with an authentication error from the transport,
  and the failure is reported through the sync health state rather than
  crashing the server

### Requirement: HTTPS token sync unaffected

The server SHALL continue to authenticate HTTPS git remotes with the
configured token (`PALI_GIT_TOKEN`) or libgit2's default credential
acquisition, with no behavior change from the SSH key-type support.

#### Scenario: HTTPS remote with token

- GIVEN an HTTPS remote and a valid `PALI_GIT_TOKEN`
- WHEN the server pulls or pushes over that remote
- THEN the transfer completes using token authentication
