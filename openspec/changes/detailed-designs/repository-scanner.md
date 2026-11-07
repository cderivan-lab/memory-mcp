# Detailed Design: Repository Scanner

## Change: add-repository-scanner

### Purpose

Produce a trustworthy, deterministic inventory of the workspace repository — a security report, a content-pinned file manifest, and a codebase insights digest — so downstream training, indexing, and memory recall can consume the repository without exposing credentials or personal data.

### Capabilities

#### New Capability: `repository-scanner`

- git-driven repository enumeration (tracked + untracked, excluding git-ignored, not following nested repos)
- Whole-file sensitive content exclusion (path patterns + credential regex patterns)
- Three deterministic artifacts: `security-scan.json`, `scan-manifest.jsonl`, `insights.json`
- Optional `--blame` with commit-ID/line-number-only (no author names, emails, or content)
- `--limit N` for deterministic path-sorted manifest prefix
- `--save-memories` to store insights as `codebase-insights` memory

### Design Decisions

#### 1. File Enumeration

- Uses `pali::workspace::{is_binary, is_sensitive, language}` for classification
- Excludes `.gitignore` patterns at compile time
- Never follows nested repositories (vendor directories excluded)
- Whole-file exclusion: if path or content matches sensitive pattern, file is excluded entirely — never redacted

#### 2. Sensitive Content Detection

- **Path-based**: Matches tracked file paths against sensitive path patterns (e.g., `config/credentials.json`)
- **Content-based**: Scans file contents (up to `--max-file-bytes`, default 2 MiB) for credential patterns (GitHub token-shaped strings, etc.)
- **Findings** store rule name, path, and line number only — never the matched value

### Artifact Structure

**security-scan.json**:

```json
{
  "repository": "workspace-name",
  "commit": "HEAD_SHA",
  "accepted_files": N,
  "excluded_files": M,
  "exclusion_policy_id": "sensitive-paths-or-credentials"
}
```

**scan-manifest.jsonl** (each line):

```json
{
  "path": "relative/file/path",
  "language": "rust|python|...",
  "commit": "HEAD_SHA",
  "sha256": "content-sha256-hash",
  "subjects": ["commit subject 1", "commit subject 2", "commit subject 3", "commit subject 4", "commit subject 5"],
  "blame": [  // only when --blame passed
    {"commit": "commit-sha", "line": 42}
  ]
}
```

**insights.json**:

```json
{
  "total_files": N,
  "languages": {"rust": 45, "python": 30, "javascript": 20},
  "areas": {"core": 20, "tooling": 15, "docs": 10},
  "largest_files": [{"path": "...", "bytes": 1024}],
  "marker_counts": {"TODO": 12, "FIXME": 5, "HACK": 3, "XXX": 1},
  "project_files": 8,
  "recent_commits": ["subject 1", "subject 2", "subject 3"]
}
```

### CLI Surface

```bash
pali scan-repos [--blame] [--max-file-bytes <N>] [--limit N] [--save-memories] [--repo-path <path>] [--scope <name>]
```

### Extension Command

- `Pali: Scan Repositories` — invokes `pali scan-repos` with default settings
- Settings: `pali.scanBlame`, `pali.scanMaxFileBytes`, `pali.scanSaveMemories`

### Verification

- Unit tests in `scanner.rs`: manifest git metadata, sensitive exclusion counts, insights determinism
- Integration: `cargo nextest run --workspace` covering scanner tests
- Determinism: Re-running on unchanged repository produces equivalent artifacts
