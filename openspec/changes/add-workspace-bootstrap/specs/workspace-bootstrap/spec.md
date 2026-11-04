# workspace-bootstrap Specification

## Purpose

Prepare a workspace for memory-backed assistance with one content-safe file
pipeline: a scannable inventory, deterministic line-window chunks, an
embedding vector index with a chunk manifest, and an exportable JSONL
dataset — all without reading secret-bearing files into outputs.

## ADDED Requirements

### Requirement: Scan produces a content-safe workspace inventory

`pali scan` SHALL walk the workspace into `<artifacts>/scan.json` (default
artifacts directory `.pali`), skipping dependency/build/dependency-cache
directories, the artifacts directory itself, symlinks, empty files,
binary files, non-UTF-8 files, and files above the size limit, and SHALL
account for skipped and sensitive files in the summary.

#### Scenario: Binary and non-text files never enter the inventory

- **WHEN** the workspace contains compiled artifacts and UTF-16 text files
- **THEN** `scan.json` lists neither and the summary counts them as skipped

### Requirement: Sensitive files are listed but withheld from content use

Files whose paths match sensitive patterns (dot-env files, key material,
package-manager credentials, SSH keys, or paths containing
"credential"/"secret") SHALL be marked sensitive; their contents SHALL NOT
be chunked, embedded, or exported, and credential-shaped lines in other
files SHALL be reported as findings containing rule and line only.

#### Scenario: A .env file is present but never chunked

- **WHEN** `pali dataset` runs on a workspace containing `.env`
- **THEN** `dataset.jsonl` contains no record sourced from `.env`
- **AND** the summary counts it as sensitive-skipped

### Requirement: Chunking is deterministic and line-bounded

Chunking SHALL split each selected file into windows of at most 80 lines and
a character cap, repeating a small line overlap between consecutive windows,
giving any single over-long line its own chunk, and identifying each chunk
by its `path:start-end` line range.

#### Scenario: The same file always yields the same chunks

- **WHEN** `pali dataset` runs twice on an unchanged file
- **THEN** both runs emit identical chunk ids and texts

### Requirement: Index embeds chunks with model validation before storage

`pali index` SHALL embed each chunk through the configured embedding backend
in fixed-size batches, reject a backend whose dimensions disagree with the
store, store vectors under `pali`-owned names `workspace/<chunk-id>` at the
root scope, and persist the usearch index with its `chunks.jsonl` manifest
under `<artifacts>/index`, failing before any walk when the embedding model
is not provisioned.

#### Scenario: A misprovisioned model fails fast

- **WHEN** `pali index` runs without a provisioned embedding model
- **THEN** the command fails before scanning any file and writes no index

#### Scenario: Dimension mismatch is a typed embedding error

- **WHEN** the backend returns vectors whose length differs from the store's
  dimensions
- **THEN** indexing aborts with an embedding error naming both dimensions

### Requirement: Dataset export defaults inside the workspace

`pali dataset` SHALL write chunk records as JSONL to `<artifacts>/dataset.jsonl`
by default and SHALL resolve a relative `--output` against the workspace root.

#### Scenario: Default output needs no argument

- **WHEN** `pali dataset` runs without an output path
- **THEN** `<artifacts>/dataset.jsonl` exists and the summary names that path

### Requirement: All three commands share one file selection

Scan, index, and dataset SHALL share one file-selection pipeline so a
`--limit` selects the same deterministic path-sorted prefix in each, and all
artifact writes SHALL be atomic.

#### Scenario: Limited index sees exactly the limited scan's files

- **WHEN** `pali scan --limit N` and `pali index --limit N` run on one
  workspace
- **THEN** the indexed files are exactly the files the limited scan reported

### Requirement: The extension exposes workspace bootstrap commands

The extension SHALL provide `Pali: Scan Workspace` (`pali.scan`) and
`Pali: Index Workspace` (`pali.index`) running the corresponding CLI command
against the first workspace folder, with progress and failures surfaced in
the extension output channel.

#### Scenario: Indexing from the command palette

- **WHEN** the user runs `Pali: Index Workspace` in an unpacked-model
  workspace
- **THEN** the command runs `pali index`, reports progress, and shows the
  model-provisioning failure without crashing the extension host
