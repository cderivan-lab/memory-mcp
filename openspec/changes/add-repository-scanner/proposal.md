# Proposal: Repository scanner

## Why

Downstream training, indexing, and memory recall need a trustworthy inventory
of the workspace's own repository: which files exist, which commit they belong
to, and what the codebase looks like in aggregate — without ever leaking a
credential or another person's identity. Commits `b5a9c11` ("Agent Host
changes for devel") shipped `pali/src/scanner.rs`, the `pali scan-repos` CLI
command, and the `pali.scanRepositories` extension command with no OpenSpec
change. This change records the capability that was implemented.

## What Changes

- New `pali::scanner` module: git-driven enumeration of the workspace's own
  repository, conservative whole-file exclusion of sensitive content, and
  three deterministic artifacts.
- New CLI command `pali scan-repos` with `--blame`, `--max-file-bytes`,
  `--save-memories`, `--repo-path`, and `--scope`.
- `save_insights` stores the insight digest as one updatable memory named
  `codebase-insights` in a pali memory repository.
- Extension command `Pali: Scan Repositories` (`pali.scanRepositories`) plus
  settings `pali.scanBlame`, `pali.scanMaxFileBytes`, and
  `pali.scanSaveMemories`.

## Capabilities

### New Capabilities

- `repository-scanner`: git-driven repository inventory with whole-file
  credential exclusion, a security report, a pinned manifest, and a
  deterministic insights digest saveable as a memory.

### Modified Capabilities

- (none)

## Impact

- `pali/src/scanner.rs` (new, ~1360 lines), `pali/src/main.rs`
  (`ScanRepos` subcommand), `pali/src/lib.rs`.
- `src/extension.ts`, `src/utils/lib.ts` (command + settings plumbing).
- Artifacts written under the workspace artifacts directory (default
  `.pali/`): `security-scan.json`, `scan-manifest.jsonl`, `insights.json`.
- Reuses `workspace::{is_binary, is_sensitive, language}` for classification.
