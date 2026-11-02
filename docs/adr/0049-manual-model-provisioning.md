# ADR-0049: Manual embedding model provisioning (drop hf-hub)

## Status
Accepted. The Dockerfile, Dockerfile.ci, and CI workflow clauses are
superseded by [ADR-0050](0050-minimal-local-core.md); manual model
provisioning stands.

## Context
ADR-0016 chose candle-core/candle-transformers for pure-Rust BERT inference
and the `hf-hub` crate to fetch BGE-small-en-v1.5 from HuggingFace Hub on
first use, caching the files under `HF_HOME`. ADR-0014 built on that by
pre-downloading the model inside a Docker build stage (`pali warmup`) so the
runtime image ships network-free.

A Windows build investigation surfaced the cost of keeping that automatic
download path. `hf-hub` 1.0 depends on the Xet protocol client (`hf-xet`,
`xet-client`, `xet-data`, `xet-core-structures`, `xet-runtime`), which
implements content-defined-chunking dedup: resource-aware chunking (`gearhash`,
`blake3`), an embedded client-side dedup database (`redb`), retry/middleware
HTTP plumbing (`reqwest-middleware`, `tokio-retry`), and per-OS system
integration (`sysinfo`; `objc2*`/`dispatch2` on macOS; `windows`/`ntapi` on
Windows beyond the `windows-sys` baseline) — for a workload that fetches one
~130 MB file once. Some names on that edge (`bon`, `darling`, `prettyplease`,
`ident_case`) also reach the graph independently through `tantivy`,
`rmcp-macros`, and `tokenizers`' own `derive_builder` dependency, so removing
`hf-hub` does not remove all of them — see Consequences for the verified net
change. (`reqwest` and its rustls/aws-lc-sys TLS stack stay regardless of this
decision: the OAuth device flow in `src/auth/oauth` depends on them directly.)

Beyond the dependency weight, automatic download couples server startup to
network availability and HuggingFace Hub uptime — the existing README/getting-
started docs already warn about first-run latency and tell users to run
`pali warmup` to work around it. The `test` CI job already caches
`~/.cache/huggingface` across runs specifically to avoid depending on network
access on every run — the dependency and the workaround were both signs the
automatic path was poorly matched to a CLI tool with no persistent service to
amortize cold starts across.

Alternatives considered:

1. **Keep hf-hub, trim its features further.** Rejected: `hf-hub` 1.0 does not
   expose a way to use the plain reqwest/ureq download path without the Xet
   client for public repos backed by Xet-enabled storage (which
   BAAI/bge-small-en-v1.5 is); the dependency weight is intrinsic to the crate
   version, not a feature-flag choice.
2. **Vendor the three model files in the repository (git or git-lfs).**
   Rejected: bloats every clone and CI checkout by ~130 MB regardless of
   whether the embedding engine is exercised, and git-lfs is an additional
   tool/service dependency this project does not otherwise require.
3. **Manual download into a conventional local directory.** Chosen.

## Decision
Remove the `hf-hub` dependency. `CandleEmbeddingEngine` loads
`config.json`, `tokenizer.json`, and `model.safetensors` from a plain local
directory, resolved by `model_dir()` in `src/embedding/candle.rs`:

1. `PALI_MODEL_DIR` environment variable
2. `<current-working-directory>/models/bge-small-en-v1.5` (the VS Code
   extension starts the server from the workspace folder, so a model vendored
   in the repository is found without extra configuration)
3. `<platform local-data-dir>/memory-mcp/models/bge-small-en-v1.5` (mirrors
   how `Config::resolve_path` derives the config file location from
   `dirs::config_dir()`)

If any of the three files is missing, `CandleEmbeddingEngine::new()` returns
`MemoryError::Embedding` naming the missing file, the resolved directory, and
the remediation (`scripts/fetch-model.sh` or setting `PALI_MODEL_DIR`). There
is no fallback network fetch.

`scripts/fetch-model.sh` is a new, dependency-free POSIX shell script that
`curl`s the three files from `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/`
into the resolved directory. It is a developer/CI convenience, not a Rust
dependency — nothing in the `pali` binary performs an HTTP request to fetch
the model.

The `warmup` subcommand keeps its name and most of its value: it still loads
the model and runs one dummy embed, which now verifies the manually-fetched
files are present and valid, and primes the OS page cache for the
memory-mapped weights file. It no longer downloads anything, so it fails
immediately (rather than falling back to a slow first download) if the model
is not provisioned.

The Dockerfile and Dockerfile.ci `model` build stage no longer calls out to
HuggingFace Hub. It expects `./models/bge-small-en-v1.5` to already exist in
the build context (populated by `scripts/fetch-model.sh` before `docker
build`), copies those files to `PALI_MODEL_DIR` under the app user, and still
runs `pali warmup` — now purely to fail the build fast on a missing or corrupt
file. The runtime image still ships the model baked in, preserving ADR-0014's
"no network fetch at startup" property; `ca-certificates` is no longer needed
in the `model` stage since it performs no TLS connection.

CI (`build.yml` `test` and `build` jobs, `publish-image.yml`) runs
`scripts/fetch-model.sh` once per job (cached by `actions/cache` keyed on the
script's hash, replacing the previous `~/.cache/huggingface` cache) before
running tests or building either Dockerfile.

## Consequences
- `Cargo.lock` drops 70 crate names entirely (diffed `name = "..."` lines
  before/after; none of the 70 appear at any version in the new lockfile) —
  `hf-hub`, `hf-xet`, `xet-client`, `xet-data`, `xet-core-structures`,
  `xet-runtime`, `globset`, `more-asserts`, and the Xet dedup machinery named
  in Context (`redb`, `sysinfo`, `blake3`, `gearhash`, `reqwest-middleware`,
  `tokio-retry`, the `objc2`/`windows`/`konst` families, etc.). `bon`,
  `darling`, `darling_core`, `darling_macro`, `prettyplease`, and `ident_case`
  remain: `tantivy` depends on `bon` independently (which pulls `bon-macros`
  → `darling`/`prettyplease`/`ident_case`), `rmcp-macros` depends on `darling`
  independently, and `tokenizers`' `derive_builder` dependency pulls a second
  `darling`/`darling_core`/`darling_macro`/`ident_case` instance independently
  of both. `reqwest`, `rustls`, and `aws-lc-sys` also remain — they are
  independently required by the OAuth device flow.
- **Behavior change for every consumer**: a `pali` installed without the model
  already present now fails fast with an actionable error instead of blocking
  on a first-run download. Existing deployments that relied on automatic
  download must run `scripts/fetch-model.sh` (or equivalent) once before
  upgrading.
- `HF_HOME` is no longer read or meaningful to Pali. `PALI_MODEL_DIR` replaces
  it as the one environment variable controlling model location.
- Offline/air-gapped setup becomes an explicit, scriptable step
  (`scripts/fetch-model.sh`) instead of an implicit network call wrapped in
  retry/caching logic inside the binary.
- ADR-0016 is amended: the "loaded via the HuggingFace Hub client (hf-hub)"
  and `HF_HOME` statements no longer hold; the core decision (candle for
  pure-Rust BERT inference) is unaffected.
- ADR-0014 is amended: the `model` build stage no longer downloads from the
  network; it validates manually-provisioned files instead. The "air-gapped
  friendly, no network fetch at startup" consequence is preserved for the
  published image.
- ADR-0023's `hf-hub` feature-flag guidance (`default-features = false` with
  `ureq`/`rustls-tls`) no longer applies — the dependency is gone, not
  reconfigured. ADR-0023's other decisions (rustls consolidation, OpenSSL
  vendoring, tokenizers' `fancy-regex`) are unaffected.
- This is a behavior-breaking change and warrants a version bump; the
  maintainer owns that decision per the release process.
