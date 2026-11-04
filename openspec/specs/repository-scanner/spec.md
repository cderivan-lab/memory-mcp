# repository-scanner Specification

## Purpose

Produce a trustworthy, deterministic inventory of the workspace repository —
a security report, a content-pinned file manifest, and a codebase insights
digest — so downstream training, indexing, and memory recall can consume the
repository without exposing credentials or personal data.

## Requirements

### Requirement: Scan enumerates only the workspace repository through git

The scanner SHALL list files through the workspace root's own git repository,
including tracked and untracked files but excluding git-ignored files, and
SHALL NOT follow nested repositories.

#### Scenario: Ignored build output stays out of the manifest

- **WHEN** `pali scan-repos` runs in a repository whose `.gitignore` excludes
  `target/`
- **THEN** no file under `target/` appears in `scan-manifest.jsonl`

#### Scenario: Nested repository files are not attributed to this workspace

- **WHEN** the workspace contains a nested checkout at `vendor/other-repo/`
- **THEN** files inside it are excluded from this scan's manifest because
  they belong to a different HEAD commit

### Requirement: Sensitive files are excluded whole, never redacted

The scanner SHALL exclude a file from the manifest entirely when its path
matches a sensitive pattern or its contents match a credential pattern, and
the matched value SHALL never be written to any artifact, log, or span.

#### Scenario: A credential-shaped line excludes the file and records only the rule

- **WHEN** an accepted candidate contains a GitHub token-shaped string
- **THEN** the file is excluded from the manifest
- **AND** the security report records the rule name, path, and line number
  but not the matched value

#### Scenario: Sensitive paths are excluded by path alone

- **WHEN** a tracked file's path matches the sensitive path pattern (for
  example a credentials JSON under `config/`)
- **THEN** its contents are never read into the manifest and the exclusion
  appears in the security report

### Requirement: Scan writes three deterministic artifacts

The scan SHALL write `<artifacts>/security-scan.json`,
`<artifacts>/scan-manifest.jsonl`, and `<artifacts>/insights.json` (artifacts
directory default `.pali`) and SHALL keep a previous run's artifacts directory
out of the manifest.

#### Scenario: Re-running the scan does not index its own output

- **WHEN** `pali scan-repos` runs twice with the same artifacts directory
- **THEN** `scan-manifest.jsonl` never lists files from the artifacts
  directory
- **AND** both runs produce equivalent artifacts for an unchanged repository

### Requirement: Manifest records pin each file to git metadata

Each manifest record SHALL contain the repository name, path, language,
current commit, SHA-256 content hash, and up to 5 recent commit subjects;
per-line blame data SHALL be included only when explicitly enabled, and SHALL
then contain commit IDs and line numbers only.

#### Scenario: Blame is off by default and privacy-bounded when on

- **WHEN** `pali scan-repos` runs without `--blame`
- **THEN** manifest records carry no blame entries
- **AND** when `--blame` is passed, records contain commit IDs and line
  numbers but never author names, emails, or source lines

#### Scenario: Limit truncates the manifest deterministically

- **WHEN** `pali scan-repos --limit N` runs on a repository with more than N
  accepted files
- **THEN** the whole repository is still scanned and reported
- **AND** the manifest contains exactly the path-sorted first N records

### Requirement: Insights digest is derived, never modelled

`insights.json` SHALL contain only values computed from accepted files —
counts, language and area distributions, largest files, unfinished-work
marker counts (TODO/FIXME/HACK/XXX), project files, and recent commit
subjects — with each list bounded, and SHALL NOT contain model output.

#### Scenario: A huge repository cannot make the digest unbounded

- **WHEN** a scan accepts thousands of files
- **THEN** each insight list holds at most the configured top-N entries

### Requirement: Insights can be saved as one updatable memory

`pali scan-repos --save-memories` SHALL store the insights markdown as a
single memory named `codebase-insights` in the target memory repository
(default `~/.memory-mcp`), under the `--scope` value or a scope defaulted
from the sanitized workspace directory name.

#### Scenario: Re-scanning updates rather than duplicates

- **WHEN** the same workspace is scanned with `--save-memories` twice
- **THEN** the repository contains one `codebase-insights` memory in that
  scope, updated in place

#### Scenario: Saving initializes a missing repository locally

- **WHEN** `--save-memories` targets a path with no memory repository
- **THEN** the repository is initialized, the memory is committed locally,
  and no remote sync is attempted

### Requirement: The extension exposes repository scanning

The VS Code extension SHALL provide the `Pali: Scan Repositories` command
(`pali.scanRepositories`) which runs `pali scan-repos` for the first
workspace folder, honoring settings `pali.scanBlame`, `pali.scanMaxFileBytes`,
and `pali.scanSaveMemories`, and SHALL surface progress and failure in
output/notices without blocking the editor.

#### Scenario: Enabling blame from settings

- **WHEN** `pali.scanBlame` is true and the user runs `Pali: Scan
  Repositories`
- **THEN** the invocation passes `--blame` while keeping commit-ID-only
  blame output
  