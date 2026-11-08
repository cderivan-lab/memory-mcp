# Spec Delta

## Purpose

Return the scanner's file enumeration to the `git2` backend after the gix
read-path experiment (ADR-0053) was reversed by ADR-0054. Observable
semantics are unchanged: tracked files from the index plus untracked files,
git-ignored files excluded, nested repositories not followed.

## MODIFIED Requirements

### Requirement: Scan enumerates only the workspace repository through git

The scanner SHALL list files through the workspace root's own git repository,
including tracked and untracked files but excluding git-ignored files, and
SHALL NOT follow nested repositories. The scanner SHALL enumerate untracked
files through libgit2's status API (`WT_NEW`, with untracked directories
expanded and ignored files excluded) rather than through a second git
backend.

#### Scenario: Ignored build output stays out of the manifest

- **WHEN** `pali scan-repos` runs in a repository whose `.gitignore` excludes
  `target/`
- **THEN** no file under `target/` appears in `scan-manifest.jsonl`

#### Scenario: Nested repository files are not attributed to this workspace

- **WHEN** the workspace contains a nested checkout at `vendor/other-repo/`
- **THEN** files inside it are excluded from this scan's manifest because
  they belong to a different HEAD commit

#### Scenario: Untracked directories are expanded file by file

- **WHEN** a worktree contains an untracked directory holding `a.md` and an
  ignored `b.md`
- **THEN** the enumeration reports `a.md` but not `b.md`
