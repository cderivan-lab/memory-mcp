# Design: Re-introduce automatic HuggingFace model download

## Context

See [proposal.md](proposal.md) for motivation. The current implementation (post-ADR-0049) loads model files exclusively from a local directory resolved via `PALI_MODEL_DIR`. This design restores the automatic HuggingFace download path that existed before ADR-0049, while keeping manual provisioning as the primary documented fallback.

## Goals / Non-Goals

**Goals:**

- Restore automatic download from HuggingFace Hub on cache miss
- Preserve `PALI_MODEL_DIR` precedence for manual provisioning
- Keep the `hf-hub` dependency minimal (only `ureq` + `sync` features)
- Maintain existing Dockerfile/CI behavior (pre-bake model in build stage)
- Document first-run latency and `pali warmup` as cache priming

**Non-Goals:**

- Re-introducing the full Xet protocol client stack (use plain HTTP download via `ureq`)
- Changing the model ID (stays `BAAI/bge-small-en-v1.5`)
- Modifying the VS Code extension's model download flow (separate TS implementation)
- Adding model configurability (single hardcoded model per ADR-0016)

## Decisions

### Decision 1: Use `hf-hub` crate with `ureq` + `sync` features

**Rationale:** The original implementation used `hf-hub` with synchronous HTTP download via `ureq`. This avoids the Xet protocol client stack that was a key reason for ADR-0049's removal. The `ureq` feature provides a minimal, dependency-light download path suitable for a headless server.

**Alternatives considered:**

- Use `reqwest` directly with HTTP range requests to HuggingFace resolve URLs — rejected because it would duplicate the cache-resolution logic that `hf-hub` already provides.
- Vendor the model files in the repository — rejected per ADR-0049 (bloats every clone).
- Keep manual-only provisioning — rejected because it creates a poor first-run experience.

### Decision 2: PALI_MODEL_DIR takes precedence over automatic download

**Rationale:** The existing resolution order (env var → CWD-relative → platform data dir) is preserved. Automatic download only triggers when the resolved directory is missing required files. This ensures:

- Pre-baked containers and air-gapped deployments work without network access
- Developers can override the model location explicitly
- The download is a fallback, not the primary path

### Decision 3: Progress bars disabled in headless mode

**Rationale:** The server runs headless; interactive progress bars would clutter stderr. The original implementation used `.with_progress(false)` on the `ApiBuilder`. Tracing logs provide observability instead.

### Decision 4: ADR-0049 is superseded, not reversed

**Rationale:** ADR-0049's decisions about Dockerfile, CI caching, and `scripts/fetch-model.sh` remain valid. Only the "no automatic download" clause is superseded. The ADR is amended to document the new default behavior while retaining the operational guidance.

## Risks / Trade-offs

- **Network coupling at first run** → Mitigation: Document first-run latency; `pali warmup` primes the cache; `PALI_MODEL_DIR` bypasses download entirely for pre-baked deployments.
- **`hf-hub` dependency weight returns** → Mitigation: Use `ureq` feature to avoid Xet stack; the dependency is only used at startup, not on the hot path.
- **HuggingFace Hub uptime dependency** → Mitigation: Manual provisioning (`scripts/fetch-model.sh`) remains the documented fallback for air-gapped environments.
- **CI caching strategy changes** → Mitigation: The existing `actions/cache` keyed on `scripts/fetch-model.sh` hash still works; the cache directory is now `HF_HOME` instead of a custom path.

## Migration Plan

1. Add `hf-hub` dependency to `pali/Cargo.toml`
2. Rewrite `load_model_files()` in `pali/src/embedding/candle.rs` to attempt HuggingFace download on cache miss
3. Update ADR-0049 to document the superseded clause
4. Update ADR-0016 to revert the `hf-hub` removal note
5. Run `cargo build` and `cargo test` to verify
6. Update `CHANGELOG.md` with the change

**Rollback:** Revert the `load_model_files()` change and remove the `hf-hub` dependency. Manual provisioning remains functional throughout.

## Open Questions

- Should we add a CLI flag (e.g., `--no-download`) to force local-only loading? Defer until there is a concrete need.
- Should the download timeout be configurable? The original implementation had no timeout; defer until a user reports a hang.
