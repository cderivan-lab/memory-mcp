# Spec Delta

## Purpose

Move the scanner's git reads to the gix backend without changing any
observable output. The scanner's security contract — exclude ignored files,
never follow nested repositories — is unchanged.

## MODIFIED Requirements

### Requirement: Scan enumerates only the workspace repository through git

The scanner SHALL list files through the workspace root's own git repository,
including tracked and untracked files but excluding git-ignored files, and
SHALL NOT follow nested repositories. The scanner SHALL obtain its repository
through the `git_read` seam rather than opening a `git2::Repository`
directly, and its output SHALL be byte-identical to the same scan taken
through the previous libgit2 backend.

#### Scenario: Ignored build output stays out of the manifest

- **WHEN** `pali scan-repos` runs in a repository whose `.gitignore` excludes
  `target/`
- **THEN** no file under `target/` appears in `scan-manifest.jsonl`

#### Scenario: Nested repository files are not attributed to this workspace

- **WHEN** the workspace contains a nested checkout at `vendor/other-repo/`
- **THEN** files inside it are excluded from this scan's manifest because
  they belong to a different HEAD commit

#### Scenario: gix scan matches the libgit2 scan

- **WHEN** `pali scan-repos` runs on a repository with 200 tracked and 12
  untracked files
- **THEN** the manifest, security report, and insights digest are byte-identical
  to the same scan taken through the libgit2 backend

#### Scenario: Manifest records stay identical through gix

- **WHEN** `pali scan-repos` records a `pinned_at_commit` for a modified file
- **THEN** the recorded commit subject and blame entry are the same ones the
  libgit2 scan would have produced
