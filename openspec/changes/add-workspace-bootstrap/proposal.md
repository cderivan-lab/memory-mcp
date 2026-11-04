# Proposal: Workspace bootstrap (scan / index / dataset)

## Why

Before any recall works, a workspace needs local groundwork: an inventory of
its readable text files with secrets withheld, an embeddable chunk store, and
an exportable dataset. Commits `b5a9c11` (and the workspace helpers it built
on) shipped `pali/src/workspace.rs`, the `pali scan|index|dataset` CLI
commands, and the `Pali: Scan Workspace` / `Pali: Index Workspace` extension
commands with no OpenSpec change. This change records that capability.

## What Changes

- New `pali::workspace` module: content-safe file scan, line-window chunking,
  embedding-index build, and dataset export over one shared file-selection
  pipeline.
- New CLI commands `pali scan`, `pali index`, `pali dataset` sharing
  workspace/artifacts/limit arguments.
- Extension commands `Pali: Scan Workspace` (`pali.scan`) and
  `Pali: Index Workspace` (`pali.index`).
- Vector index stored under `pali`-owned names (`workspace/<path:start-end>`)
  in the scope-rooted usearch store; chunks exported as JSONL.

## Capabilities

### New Capabilities

- `workspace-bootstrap`: content-safe workspace inventory, deterministic
  chunking, embedding index build, and dataset export from a shared
  file-selection pipeline.

### Modified Capabilities

- (none)

## Impact

- `pali/src/workspace.rs`, `pali/src/main.rs` (`Scan`, `Index`, `Dataset`
  subcommands).
- `src/extension.ts` (bootstrap commands and progress output).
- Artifacts under the workspace artifacts directory (default `.pali/`):
  `scan.json`, `index/`, `chunks.jsonl`, `dataset.jsonl`.
- `pali index` requires a provisioned embedding model and respects
  `pali.logLevel` diagnostics for dimension mismatches.
