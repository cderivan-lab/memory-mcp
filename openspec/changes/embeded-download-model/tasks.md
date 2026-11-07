# Tasks

## 1. Dependency and ADR updates

- [ ] 1.1 Add `hf-hub` dependency to `pali/Cargo.toml` with `ureq` and `sync` features and verify `cargo build` succeeds
- [ ] 1.2 Update `docs/adr/0049-manual-model-provisioning.md` to supersede the "no automatic download" clause and document the new default behavior
- [ ] 1.3 Update `docs/adr/0016-candle-direct-embeddings.md` to revert the `hf-hub` removal note

## 2. Implement automatic download in load_model_files

- [ ] 2.1 Add `hf_hub` imports to `pali/src/embedding/candle.rs`
- [ ] 2.2 Rewrite `load_model_files()` to attempt HuggingFace download when local files are missing, preserving `PALI_MODEL_DIR` precedence
- [ ] 2.3 Ensure download respects `HF_HOME` and `HF_ENDPOINT` environment variables
- [ ] 2.4 Disable progress bars during download and log status via tracing
- [ ] 2.5 Verify `cargo build` compiles without warnings

## 3. Testing

- [ ] 3.1 Run existing embedding tests (`cargo test -p pali embedding`) to ensure no regressions
- [ ] 3.2 Run `cargo nextest run --workspace --no-fail-fast` for full test suite
- [ ] 3.3 Run `cargo clippy -- -D warnings` and `cargo fmt -- --check` to satisfy pre-commit gates

## 4. Documentation and changelog

- [ ] 4.1 Update `CHANGELOG.md` with the change description
- [ ] 4.2 Update `docs/getting-started.md` to document first-run latency and `pali warmup` as cache priming
- [ ] 4.3 Update `docs/configuration.md` to document `HF_HOME` and `HF_ENDPOINT` support

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Verify the archived result.
