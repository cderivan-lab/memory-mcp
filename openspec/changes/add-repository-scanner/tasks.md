# Tasks: Repository scanner

Implemented in commit `b5a9c11`; tasks record the delivered slices.

## 1. Scanner core

- [x] 1.1 `pali::scanner` module: git-driven enumeration of the workspace's
      own repo (tracked + untracked, not ignored), nested repos not followed
- [x] 1.2 Whole-file exclusion policy: sensitive path patterns and
      credential content rules; findings store rule/path/line only
- [x] 1.3 Size guard `--max-file-bytes` (default 2 MiB) and binary sniffing
      reusing `workspace::is_binary`

## 2. Artifacts

- [x] 2.1 `<artifacts>/security-scan.json` with repository/accepted/finding
      counts and the exclusion policy id
- [x] 2.2 `<artifacts>/scan-manifest.jsonl` pinned to HEAD commit, SHA-256
      content hash, language, and ≤5 commit subjects
- [x] 2.3 Optional `--blame` attaching commit-ID/line-number-only blame
- [x] 2.4 `<artifacts>/insights.json` deterministic digest (languages, areas,
      largest files, markers, project files, recent commits; top-N bounded)
- [x] 2.5 `--limit` deterministic path-sorted manifest prefix

## 3. Memory persistence

- [x] 3.1 `save_insights`: init-or-open memory repo, scope from `--scope` or
      sanitized workspace dir name, single updatable `codebase-insights`
      memory, local commit only
- [x] 3.2 `--save-memories` flag wired in the CLI with summary JSON output

## 4. CLI and extension surface

- [x] 4.1 `pali scan-repos` subcommand with workspace/artifacts/limit args
      shared with `scan`/`index`/`dataset`
- [x] 4.2 `Pali: Scan Repositories` command in the extension
- [x] 4.3 Settings `pali.scanBlame`, `pali.scanMaxFileBytes`,
      `pali.scanSaveMemories` mapped to CLI flags

## 5. Verification

- [x] 5.1 Unit tests in `scanner.rs` (manifest git metadata, sensitive
      exclusion counts, insights determinism)
- [ ] 5.2 Record a `cargo nextest run --workspace` receipt covering the
      scanner tests in the PR description
