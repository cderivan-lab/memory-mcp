# Proposal: Re-introduce automatic HuggingFace model download

## Why

ADR-0049 removed automatic HuggingFace model downloads to eliminate the `hf-hub` dependency weight and decouple server startup from network availability. However, this created a friction point: users must now manually run `scripts/fetch-model.sh` or pre-provision the model before the server can start, which is a poor first-run experience and adds operational overhead in environments where the model is not pre-baked into containers or images. The original implementation (before ADR-0049) provided automatic download with caching as a convenience, and re-introducing it — while keeping manual provisioning as a documented fallback — restores that convenience without losing the ADR's dependency and startup-isolation goals.

## What Changes

- **Re-add `hf-hub` dependency** to `pali/Cargo.toml` with `ureq` and `sync` features for headless download.
- **Restore automatic download path** in `load_model_files()` that fetches `config.json`, `tokenizer.json`, and `model.safetensors` from HuggingFace Hub on cache miss, respecting `HF_HOME` and `HF_ENDPOINT` environment variables.
- **Preserve manual provisioning as fallback**: `PALI_MODEL_DIR` still takes precedence; automatic download only triggers when the local directory is missing required files.
- **Update ADR-0049** to supersede the "no automatic download" decision while retaining the Dockerfile/CI changes that pre-bake the model.
- **Update ADR-0016** to revert the `hf-hub` removal note.

## Capabilities

### New Capabilities

- `embedding-model-loading`: Loads BGE-small-en-v1.5 embedding model files either from a local directory (`PALI_MODEL_DIR`) or automatically from HuggingFace Hub on first use, caching in the standard HF cache directory. Manual provisioning remains the documented fallback for air-gapped or pre-baked deployments.

### Modified Capabilities

- (none — no existing spec covers embedding model loading)

## Impact

- `pali/Cargo.toml`: Add `hf-hub` dependency.
- `pali/src/embedding/candle.rs`: Restore `hf_hub` imports and rewrite `load_model_files()` to attempt HuggingFace download when local files are missing; `model_dir()` resolution order stays the same.
- `docs/adr/0049-manual-model-provisioning.md`: Supersede the "no automatic download" clause; document that automatic download is the default with manual provisioning as fallback.
- `docs/adr/0016-candle-direct-embeddings.md`: Revert the `hf-hub` removal note.
- `scripts/fetch-model.sh`: Unchanged — remains the explicit manual provisioning path.
- Dockerfile/Dockerfile.ci: Unchanged — still pre-bake the model for runtime images.
