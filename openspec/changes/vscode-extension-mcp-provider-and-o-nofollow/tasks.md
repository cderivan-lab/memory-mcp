# Tasks

## 1. VS Code extension MCP registration

- [ ] 1.1 Change `lib.js` export from `mcpInstallUrl` to `mcpServerDefinition`
      returning `{ label, command, args, env }`.
- [ ] 1.2 Rewrite `activate` in `extension.js` to register the MCP server
      definition provider and fire `serverChanged` on config change; drop the
      `pali.installMcp` / `pali.installHooks` commands and the `INSTALLED_KEY`
      global-state stamp.
- [ ] 1.3 Update `package.json`: replace the two `commands` contributions with
      one `mcpServerDefinitionProviders` point; add the `package` script.
- [ ] 1.4 Update `vscode-extension/test/extension.test.js` to assert on
      `mcpServerDefinition` instead of the install URL.
- [ ] 1.5 Update `vscode-extension/README.md`, `README.md`,
      `docs/clients.md`, and `docs/getting-started.md` for the new flow.

## 2. Remove `native-certs` cargo feature

- [ ] 2.1 Delete the `[features]` block from `Cargo.toml`.
- [ ] 2.2 Update `AGENTS.md` to drop the `native-certs` mention in the semver
      sentence.
- [ ] 2.3 Add the CHANGELOG entry under `[Unreleased] > Changed`.

## 3. Platform-correct `O_NOFOLLOW`

- [ ] 3.1 Add `pub(crate) const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;` with the
      kernel-family doc comment in `src/fs_util.rs`.
- [ ] 3.2 Add `libc = "0.2"` under `[target.'cfg(unix)'.dependencies]` in
      `Cargo.toml`.
- [ ] 3.3 Replace `custom_flags(0x20000)` with `custom_flags(O_NOFOLLOW)` in
      `src/fs_util.rs` and `crate::fs_util::O_NOFOLLOW` in `src/repo.rs`.
- [ ] 3.4 Verify `cargo build --target x86_64-apple-darwin` succeeds (macOS flag
      resolves to `0x0100`).

## 4. rustdoc cleanup

- [ ] 4.1 Convert `[`model_dir`]` and `[`load_model_files`]` intra-doc links to
      plain code spans in `src/embedding/candle.rs`.
- [ ] 4.2 Run `cargo doc --no-deps` with no warnings.

## 5. Verification

- [ ] 5.1 `openspec validate` passes for the change.
- [ ] 5.2 `cargo fmt -- --check`, `cargo clippy -- -D warnings`, and
      `cargo doc --no-deps` are clean.
- [ ] 5.3 `node --test vscode-extension/test/extension.test.js` passes.