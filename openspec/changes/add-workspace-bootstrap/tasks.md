# Tasks: Workspace bootstrap

Implemented across commits `70577cd`–`b5a9c11`; tasks record the delivered
slices.

## 1. Scan

- [x] 1.1 Shared `ScanOptions` (root, artifacts dir, deterministic limit,
      max file bytes) with atomic artifact writes
- [x] 1.2 Directory/binary/UTF-8/size skip rules; `.pali` and artifacts dir
      excluded from their own input
- [x] 1.3 Sensitive-path classification and credential-line findings
      (rule + line only, never the value)
- [x] 1.4 `<artifacts>/scan.json` summary report

## 2. Chunking and dataset

- [x] 2.1 Line-window chunker: 80-line windows, character cap, small
      overlap, single over-long line gets its own chunk, `path:start-end`
      ids
- [x] 2.2 `pali dataset` JSONL export with defaulted and workspace-relative
      output paths

## 3. Index

- [x] 3.1 Batched embedding through `EmbeddingBackend` with length and
      dimension validation (`MemoryError::Embedding`)
- [x] 3.2 usearch store persisted to `<artifacts>/index` with
      `chunks.jsonl` manifest; names `workspace/<chunk-id>` at `Scope::Root`
- [x] 3.3 Fail-fast when the embedding model is not provisioned

## 4. CLI and extension surface

- [x] 4.1 `pali scan`, `pali index`, `pali dataset` sharing
      workspace/artifacts/limit arguments
- [x] 4.2 `Pali: Scan Workspace` and `Pali: Index Workspace` extension
      commands with output-channel progress

## 5. Verification

- [x] 5.1 Unit tests for skip rules, sensitive withholding, chunk
      determinism, and limit prefix stability
- [ ] 5.2 Record a `cargo nextest run --workspace` receipt covering the
      workspace tests in the PR description
