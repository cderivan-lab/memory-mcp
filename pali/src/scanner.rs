//! Repository scanner — enumerate the current workspace repository's tracked
//! and untracked (but not ignored) files, and write the security report, scan
//! manifest, and codebase insights that downstream training, indexing, and
//! memory recall consume.
//!
//! The policy is conservative **whole-file exclusion**: a file whose path looks
//! sensitive, or whose contents match a credential pattern, never enters the
//! manifest. Redaction would change source semantics, and a partially redacted
//! file is still a leak. Findings record only the rule, path, and line — the
//! matched value is never written to an artifact, log, or span.
//!
//! Only the workspace root's own repository is scanned. Nested repositories are
//! not followed: their files belong to a different checkout with its own
//! history, and silently mixing them into this workspace's manifest would
//! attribute them to the wrong HEAD commit. Files are listed through git, so
//! `.gitignore` rules apply and generated build output stays out.
//!
//! Insights are deterministic: counts and paths derived from the accepted
//! files, never model output. The digest is written to `insights.json` and can
//! be saved as one memory with `save_insights`.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::MemoryError,
    fs_util,
    types::{Memory, MemoryMetadata, Scope, ScopePath},
    workspace::{is_binary, is_sensitive, language},
};

/// Default maximum size of a file included in a scan.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Commit subjects recorded per repository.
const COMMIT_MESSAGES: usize = 5;
/// Leading bytes searched for generated-file markers.
const GENERATED_SNIFF_CHARS: usize = 4_096;
/// Default artifacts directory, relative to the workspace root.
const DEFAULT_ARTIFACTS_DIR: &str = ".pali";
/// Memory name used by `save_insights`.
pub const INSIGHTS_MEMORY_NAME: &str = "codebase-insights";
/// Entries retained per insight list, so one huge repository cannot make the
/// digest unbounded.
const INSIGHT_TOP_N: usize = 8;
/// Markers counted in file contents. They signal unfinished or risky code.
const MARKERS: [&str; 4] = ["TODO", "FIXME", "HACK", "XXX"];

/// Directories whose contents are never scanned, matched on any path
/// component.
const BLOCKED_DIRS: &[&str] = &[
    ".git",
    ".terraform",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "dumps",
    "fixtures",
    "generated",
    "logs",
    "node_modules",
    "testdata",
    "vendor",
];

/// Inputs for a repository scan.
///
/// Construct with [`RepositoryScanOptions::new`], then chain the optional
/// settings.
#[derive(Debug, Clone)]
pub struct RepositoryScanOptions {
    root: PathBuf,
    artifacts: Option<PathBuf>,
    limit: Option<usize>,
    max_file_bytes: u64,
    blame: bool,
}

impl RepositoryScanOptions {
    /// Resolve `root` as the workspace directory whose own git repository is
    /// scanned.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, MemoryError> {
        let root = fs_util::canonicalize_allow_missing(&root.into())?;
        if !root.is_dir() {
            return Err(MemoryError::InvalidInput {
                reason: format!("workspace is not a directory: {}", root.display()),
            });
        }
        Ok(Self {
            root,
            artifacts: None,
            limit: None,
            max_file_bytes: MAX_FILE_BYTES,
            blame: false,
        })
    }

    /// Set the artifacts directory. A relative path resolves against the
    /// workspace root; the default is `<workspace>/.pali`.
    #[must_use]
    pub fn with_artifacts(mut self, dir: impl Into<PathBuf>) -> Self {
        self.artifacts = Some(dir.into());
        self
    }

    /// Bound the number of manifest records. The whole workspace is still
    /// scanned and reported; only the manifest is truncated to a deterministic
    /// path-sorted prefix.
    #[must_use]
    pub fn with_limit(mut self, limit: usize) -> Self {
        self.limit = Some(limit);
        self
    }

    /// Set the maximum size in bytes of an included file.
    #[must_use]
    pub fn with_max_file_bytes(mut self, max: u64) -> Self {
        self.max_file_bytes = max.max(1);
        self
    }

    /// Record per-line commit metadata from `git blame`. Only commit IDs and
    /// final line numbers are persisted; author names, emails, and source
    /// lines are never read into the manifest.
    #[must_use]
    pub fn with_blame(mut self, blame: bool) -> Self {
        self.blame = blame;
        self
    }

    /// Absolute workspace root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn artifacts_dir(&self) -> PathBuf {
        match &self.artifacts {
            Some(dir) if dir.is_absolute() => dir.clone(),
            Some(dir) => self.root.join(dir),
            None => self.root.join(DEFAULT_ARTIFACTS_DIR),
        }
    }
}

/// Result of a repository scan. The full report is at
/// [`RepositoryScanSummary::security_report`]; the manifest is at
/// [`RepositoryScanSummary::manifest`].
#[derive(Debug, Serialize)]
pub struct RepositoryScanSummary {
    /// Number of git repositories scanned. Always 1: the workspace itself.
    pub repositories: usize,
    /// Files accepted into the manifest.
    pub accepted_files: usize,
    /// Manifest records written after applying the limit.
    pub selected: usize,
    /// Potential secrets and path exclusions reported. Matched values are
    /// never recorded.
    pub findings: usize,
    /// Path of the JSON security report.
    pub security_report: String,
    /// Path of the JSONL manifest.
    pub manifest: String,
    /// Path of the JSON codebase insights.
    pub insights: String,
    /// Markdown digest of the insights, ready to save as one memory. Not part
    /// of the printed JSON summary.
    #[serde(skip)]
    pub insights_markdown: String,
}

/// A file excluded from the manifest, by path or by content finding. The
/// matched value is never stored.
#[derive(Debug, Serialize)]
struct Finding {
    repo: String,
    path: String,
    rule: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<usize>,
}

/// Full security report written to `<artifacts>/security-scan.json`.
#[derive(Debug, Serialize)]
struct SecurityReport {
    repositories: usize,
    accepted_files: usize,
    findings: Vec<Finding>,
    policy: &'static str,
}

/// One line of a file's git blame history.
#[derive(Debug, Clone, Serialize)]
struct BlameLine {
    commit: String,
    line: usize,
}

/// One accepted file, as written to the manifest.
#[derive(Debug, Serialize)]
struct ManifestRecord {
    repo: String,
    path: String,
    language: String,
    commit: String,
    content_hash: String,
    commit_messages: Vec<String>,
    blame: Vec<BlameLine>,
}

/// Per-file facts that only feed the insight derivation, never the manifest.
struct FileFacts {
    path: String,
    language: String,
    bytes: u64,
    markers: [usize; MARKERS.len()],
    test: bool,
}

/// A language's share of the accepted files.
#[derive(Debug, Serialize)]
struct LanguageInsight {
    language: String,
    files: usize,
    bytes: u64,
}

/// A top-level directory's file count. Files at the repository root are
/// grouped under `(root)`.
#[derive(Debug, Serialize)]
struct AreaInsight {
    path: String,
    files: usize,
}

/// A file worth a look because of its size.
#[derive(Debug, Serialize)]
struct FileInsight {
    path: String,
    bytes: u64,
}

/// One unfinished-work marker and how often it appears.
#[derive(Debug, Serialize)]
struct MarkerInsight {
    marker: &'static str,
    count: usize,
}

/// Codebase insights written to `<artifacts>/insights.json`.
#[derive(Debug, Serialize)]
struct Insights {
    repo: String,
    commit: String,
    files: usize,
    test_files: usize,
    languages: Vec<LanguageInsight>,
    areas: Vec<AreaInsight>,
    largest_files: Vec<FileInsight>,
    markers: Vec<MarkerInsight>,
    project_files: Vec<String>,
    recent_commits: Vec<String>,
}

/// What one repository scan accumulates for the artifacts it writes.
#[derive(Default)]
struct ScanAccumulator {
    records: Vec<ManifestRecord>,
    facts: Vec<FileFacts>,
    findings: Vec<Finding>,
    skipped: usize,
}

/// Repository-level values shared by every file in one scan.
struct RepositoryContext<'a> {
    name: &'a str,
    commit: &'a str,
    messages: &'a [String],
}

/// Scan the workspace's own git repository and write
/// `<artifacts>/security-scan.json`, `<artifacts>/scan-manifest.jsonl`, and
/// `<artifacts>/insights.json`.
///
/// The workspace must itself be a git repository; nested repositories are not
/// followed. The workspace is read-only: nothing outside the artifacts
/// directory is written.
pub fn scan_repositories(
    options: &RepositoryScanOptions,
) -> Result<RepositoryScanSummary, MemoryError> {
    let _span =
        tracing::info_span!("workspace.repositories", root = %options.root.display()).entered();

    if !is_repository(&options.root) {
        return Err(MemoryError::InvalidInput {
            reason: format!(
                "workspace is not a git repository: {}",
                options.root.display()
            ),
        });
    }

    let artifacts = options.artifacts_dir();
    std::fs::create_dir_all(&artifacts)?;
    let artifacts_prefix = relative_prefix(&options.root, &artifacts);

    let repo = git2::Repository::open(&options.root)?;
    let label = repo_name(&options.root);
    let commit = head_commit(&repo).unwrap_or_default();
    let messages = commit_messages(&repo);

    let mut scan = ScanAccumulator::default();
    let context = RepositoryContext {
        name: &label,
        commit: &commit,
        messages: &messages,
    };
    scan_repository(
        &repo,
        &context,
        options,
        artifacts_prefix.as_deref(),
        &mut scan,
    )?;

    let ScanAccumulator {
        mut records,
        facts,
        findings,
        skipped,
    } = scan;
    let accepted_files = records.len();
    let finding_count = findings.len();
    let selected = options
        .limit
        .map_or(accepted_files, |limit| accepted_files.min(limit));
    records.truncate(selected);

    let insights = derive_insights(&label, &commit, &messages, &facts);
    let insights_report = artifacts.join("insights.json");
    write_json(&insights_report, &insights)?;
    let insights_markdown = render_insights(&insights);

    let security_report = artifacts.join("security-scan.json");
    let manifest = artifacts.join("scan-manifest.jsonl");

    write_json(
        &security_report,
        &(SecurityReport {
            repositories: 1,
            accepted_files,
            findings,
            policy: "whole-file exclusion; findings contain no matched values",
        }),
    )?;
    write_jsonl(&manifest, &records)?;

    tracing::info!(
        repository = %options.root.display(),
        accepted = accepted_files,
        selected,
        skipped,
        "repository scan complete"
    );

    Ok(RepositoryScanSummary {
        repositories: 1,
        accepted_files,
        selected,
        findings: finding_count,
        security_report: security_report.display().to_string(),
        manifest: manifest.display().to_string(),
        insights: insights_report.display().to_string(),
        insights_markdown,
    })
}

fn is_repository(path: &Path) -> bool {
    path.join(".git").exists()
}

/// Path of `artifacts` relative to `root`, `/`-separated, when it is inside
/// the workspace. Used to keep a previous run's artifacts out of the manifest.
fn relative_prefix(root: &Path, artifacts: &Path) -> Option<String> {
    let relative = artifacts.strip_prefix(root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    let joined = parts.join("/");
    (!joined.is_empty()).then_some(joined)
}

fn scan_repository(
    repo: &git2::Repository,
    context: &RepositoryContext<'_>,
    options: &RepositoryScanOptions,
    artifacts_prefix: Option<&str>,
    scan: &mut ScanAccumulator,
) -> Result<(), MemoryError> {
    let repo_path = options.root.as_path();

    for relative in list_paths(repo)? {
        if relative.is_empty() {
            continue;
        }
        if is_artifacts_path(&relative, artifacts_prefix) {
            scan.skipped += 1;
            continue;
        }
        if path_excluded(&relative) {
            scan.findings.push(Finding {
                repo: context.name.to_string(),
                path: relative,
                rule: "excluded_path",
                line: None,
            });
            scan.skipped += 1;
            continue;
        }

        let path = repo_path.join(&relative);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                scan.skipped += 1;
                continue;
            }
        };
        if metadata.file_type().is_symlink() || parent_is_symlink(repo_path, &path) {
            scan.findings.push(Finding {
                repo: context.name.to_string(),
                path: relative,
                rule: "symlink",
                line: None,
            });
            scan.skipped += 1;
            continue;
        }
        if !metadata.is_file() {
            scan.skipped += 1;
            continue;
        }
        if metadata.len() == 0 || metadata.len() > options.max_file_bytes {
            scan.findings.push(Finding {
                repo: context.name.to_string(),
                path: relative,
                rule: "oversized",
                line: None,
            });
            scan.skipped += 1;
            continue;
        }

        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!(path = %relative, error = %e, "skipping unreadable file");
                scan.skipped += 1;
                continue;
            }
        };
        if is_binary(&bytes) {
            scan.skipped += 1;
            continue;
        }
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                scan.skipped += 1;
                continue;
            }
        };
        if is_generated(&relative, &content) {
            scan.skipped += 1;
            continue;
        }
        if is_sensitive(&relative) {
            scan.skipped += 1;
            continue;
        }

        let issues = findings_in(&content);
        if !issues.is_empty() {
            scan.findings
                .extend(issues.into_iter().map(|(rule, line)| Finding {
                    repo: context.name.to_string(),
                    path: relative.clone(),
                    rule,
                    line: Some(line),
                }));
            scan.skipped += 1;
            continue;
        }

        let language = language(&relative).to_string();
        scan.facts.push(FileFacts {
            path: relative.clone(),
            language: language.clone(),
            bytes: metadata.len(),
            markers: MARKERS.map(|marker| content.matches(marker).count()),
            test: is_test_path(&relative),
        });

        let blame = if options.blame {
            blame_lines(repo, &relative)
        } else {
            Vec::new()
        };

        scan.records.push(ManifestRecord {
            repo: context.name.to_string(),
            path: relative,
            language,
            commit: context.commit.to_string(),
            content_hash: content_hash(&content),
            commit_messages: context.messages.to_vec(),
            blame,
        });
    }

    Ok(())
}

fn repo_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".to_string())
}

fn head_commit(repo: &git2::Repository) -> Option<String> {
    let head = repo.head().ok()?;
    Some(head.peel_to_commit().ok()?.id().to_string())
}

/// The most recent commit subjects, skipping any that match a credential
/// pattern. A commit subject is persisted into an artifact, so it goes
/// through the same scanner as file content.
fn commit_messages(repo: &git2::Repository) -> Vec<String> {
    let mut messages = Vec::new();
    let Ok(mut walk) = repo.revwalk() else {
        return messages;
    };
    if walk.push_head().is_err() {
        return messages;
    }
    for oid in walk.take(COMMIT_MESSAGES) {
        let Ok(oid) = oid else {
            continue;
        };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let Ok(Some(summary)) = commit.summary() else {
            continue;
        };
        if findings_in(summary).is_empty() {
            messages.push(summary.to_string());
        }
    }
    messages
}

/// Tracked files plus untracked files that `.gitignore` does not exclude.
///
/// Tracked paths come from the index; untracked paths are libgit2's
/// `WT_NEW` set (recursing into untracked directories), matching what
/// `git status` reports.
fn list_paths(repo: &git2::Repository) -> Result<BTreeSet<String>, MemoryError> {
    let mut paths = BTreeSet::new();

    for entry in repo.index()?.iter() {
        if let Ok(path) = std::str::from_utf8(&entry.path) {
            paths.insert(path.to_string());
        }
    }

    let mut status_options = git2::StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    for status in repo.statuses(Some(&mut status_options))?.iter() {
        if status.status().contains(git2::Status::WT_NEW)
            && let Ok(path) = status.path()
        {
            paths.insert(path.to_string());
        }
    }

    Ok(paths)
}

fn is_artifacts_path(relative: &str, prefix: Option<&str>) -> bool {
    prefix.is_some_and(|prefix| {
        relative
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// True when the file itself or any directory between it and the repository
/// root is a symlink.
fn parent_is_symlink(repo: &Path, path: &Path) -> bool {
    let mut current = path.parent();
    while let Some(directory) = current {
        let is_symlink = std::fs::symlink_metadata(directory)
            .is_ok_and(|metadata| metadata.file_type().is_symlink());
        if is_symlink {
            return true;
        }
        if directory == repo {
            break;
        }
        current = directory.parent();
    }
    false
}

/// Files whose path marks them as credentials, private data, or generated
/// output. Matching is per path component, so a directory named `secrets`
/// excludes everything below it.
fn path_excluded(relative: &str) -> bool {
    relative
        .split('/')
        .any(|part| BLOCKED_DIRS.contains(&part) || path_pattern().is_match(part))
}

/// Generated files are not source: they carry no design intent worth
/// indexing and change on every build.
pub(crate) fn is_generated(relative: &str, content: &str) -> bool {
    relative.ends_with(".pb.go")
        || relative.contains(".gen.")
        || content
            .chars()
            .take(GENERATED_SNIFF_CHARS)
            .collect::<String>()
            .contains("DO NOT EDIT")
}

fn content_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// Per-line commit IDs and final line numbers, in file order.
///
/// Blame can fail for a file that is not committed yet; the file still
/// belongs in the manifest, so a failure yields no blame rather than an
/// error.
fn blame_lines(repo: &git2::Repository, relative: &str) -> Vec<BlameLine> {
    let blame = match repo.blame_file(Path::new(relative), None) {
        Ok(blame) => blame,
        Err(e) => {
            tracing::debug!(path = %relative, error = %e, "no blame available");
            return Vec::new();
        }
    };

    let mut lines = Vec::new();
    for hunk in blame.iter() {
        let commit = hunk.final_commit_id().to_string();
        let start = hunk.final_start_line();
        for offset in 0..hunk.lines_in_hunk() {
            lines.push(BlameLine {
                commit: commit.clone(),
                line: start + offset,
            });
        }
    }
    lines.sort_by_key(|line| line.line);
    lines
}

/// Derive deterministic insights from the accepted files.
fn derive_insights(repo: &str, commit: &str, messages: &[String], files: &[FileFacts]) -> Insights {
    let mut languages: BTreeMap<&str, (usize, u64)> = BTreeMap::new();
    let mut areas: BTreeMap<&str, usize> = BTreeMap::new();
    let mut markers = [0usize; MARKERS.len()];
    let mut test_files = 0usize;
    let mut project_files = Vec::new();

    for file in files {
        let entry = languages.entry(file.language.as_str()).or_default();
        entry.0 += 1;
        entry.1 += file.bytes;

        let area = file.path.split_once('/').map_or("(root)", |(area, _)| area);
        *areas.entry(area).or_default() += 1;

        for (index, count) in file.markers.iter().enumerate() {
            markers[index] += count;
        }
        if file.test {
            test_files += 1;
        }
        if is_project_file(&file.path) {
            project_files.push(file.path.clone());
        }
    }

    let mut languages: Vec<LanguageInsight> = languages
        .into_iter()
        .map(|(language, (files, bytes))| LanguageInsight {
            language: language.to_string(),
            files,
            bytes,
        })
        .collect();
    languages.sort_by(|a, b| b.files.cmp(&a.files).then(a.language.cmp(&b.language)));

    let mut areas: Vec<AreaInsight> = areas
        .into_iter()
        .map(|(path, files)| AreaInsight {
            path: path.to_string(),
            files,
        })
        .collect();
    areas.sort_by(|a, b| b.files.cmp(&a.files).then(a.path.cmp(&b.path)));

    let mut largest_files: Vec<FileInsight> = files
        .iter()
        .map(|file| FileInsight {
            path: file.path.clone(),
            bytes: file.bytes,
        })
        .collect();
    largest_files.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.path.cmp(&b.path)));

    Insights {
        repo: repo.to_string(),
        commit: commit.to_string(),
        files: files.len(),
        test_files,
        languages: languages.into_iter().take(INSIGHT_TOP_N).collect(),
        areas: areas.into_iter().take(INSIGHT_TOP_N).collect(),
        largest_files: largest_files.into_iter().take(INSIGHT_TOP_N / 2).collect(),
        markers: MARKERS
            .iter()
            .zip(markers)
            .filter(|(_, count)| *count > 0)
            .map(|(marker, count)| MarkerInsight { marker, count })
            .collect(),
        project_files: project_files.into_iter().take(INSIGHT_TOP_N).collect(),
        recent_commits: messages.to_vec(),
    }
}

/// Render the insights as a markdown memory body. Values are counts and paths
/// only; no file content is copied.
fn render_insights(insights: &Insights) -> String {
    let mut lines = vec![
        format!("# Codebase insights — {}", insights.repo),
        String::new(),
        "Auto-generated by `pali scan` from the repository's tracked and".to_string(),
        "untracked files. Counts and paths only; excluded (sensitive) files are".to_string(),
        "not represented.".to_string(),
        String::new(),
        format!(
            "- Checkout: {}",
            if insights.commit.is_empty() {
                "no commits".to_string()
            } else {
                insights.commit.clone()
            }
        ),
        format!(
            "- Files: {} ({} test files)",
            insights.files, insights.test_files
        ),
    ];

    if !insights.languages.is_empty() {
        let rendered = insights
            .languages
            .iter()
            .map(|language| {
                format!(
                    "{} {} files ({})",
                    language.language,
                    language.files,
                    format_bytes(language.bytes)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("- Languages: {rendered}"));
    }
    if !insights.areas.is_empty() {
        let rendered = insights
            .areas
            .iter()
            .map(|area| format!("{} {}", area.path, area.files))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("- Areas: {rendered}"));
    }
    if !insights.largest_files.is_empty() {
        let rendered = insights
            .largest_files
            .iter()
            .map(|file| format!("`{}` ({})", file.path, format_bytes(file.bytes)))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("- Largest files: {rendered}"));
    }
    if !insights.markers.is_empty() {
        let rendered = insights
            .markers
            .iter()
            .map(|marker| format!("{} {}", marker.marker, marker.count))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("- Unfinished markers: {rendered}"));
    }
    if !insights.project_files.is_empty() {
        lines.push(format!(
            "- Project files: {}",
            insights.project_files.join(", ")
        ));
    }
    if !insights.recent_commits.is_empty() {
        lines.push(String::new());
        lines.push("## Recent commits".to_string());
        lines.push(String::new());
        for message in &insights.recent_commits {
            lines.push(format!("- {message}"));
        }
    }

    lines.join("\n")
}

fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    #[allow(clippy::cast_precision_loss)]
    let value = bytes as f64;
    if value >= MB {
        format!("{:.1} MB", value / MB)
    } else if value >= KB {
        format!("{:.1} KB", value / KB)
    } else {
        format!("{bytes} B")
    }
}

/// Test files by common convention: a `test`/`tests`/`spec` path component, a
/// `_test`/`_spec` stem, or a `.test.`/`.spec.` infix.
fn is_test_path(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or(&lower);
    path.split('/')
        .any(|part| matches!(part, "test" | "tests" | "spec" | "specs" | "__tests__"))
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || stem.starts_with("test_")
        || lower.contains(".test.")
        || lower.contains(".spec.")
}

/// Files that describe how a project is built, tested, or packaged.
fn is_project_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "README"
            | "README.md"
            | "README.rst"
            | "AGENTS.md"
            | "CLAUDE.md"
            | "CONTRIBUTING.md"
            | "Cargo.toml"
            | "package.json"
            | "pyproject.toml"
            | "requirements.txt"
            | "go.mod"
            | "Dockerfile"
            | "Makefile"
            | "deny.toml"
            | "rust-toolchain.toml"
            | "tsconfig.json"
            | ".gitignore"
    ) || path.starts_with(".github/workflows/")
}

/// Save an insight digest as one memory in a pali memory repository.
///
/// The memory is named [`INSIGHTS_MEMORY_NAME`] inside `scope`, so saving the
/// same workspace again updates that memory instead of adding a duplicate. The
/// repository is opened or initialised through the same [`MemoryRepo`] path the
/// server uses, which commits the file locally and never syncs.
///
/// [`MemoryRepo`]: crate::repo::MemoryRepo
pub async fn save_insights(
    repo_path: &Path,
    scope: &str,
    markdown: &str,
) -> Result<(), MemoryError> {
    let repo = Arc::new(crate::repo::MemoryRepo::init_or_open(repo_path, None)?);
    let scope = Scope::Path(ScopePath::new(scope)?);
    let metadata = MemoryMetadata::new(
        scope,
        vec!["codebase-insights".to_string(), "scan".to_string()],
        Some("pali scan".to_string()),
    );
    let memory = Memory::new(INSIGHTS_MEMORY_NAME, markdown, metadata)?;
    repo.save_memory(&memory).await
}

/// Scope name derived from the workspace directory name, reduced to the
/// characters a [`ScopePath`] accepts.
pub fn default_scope(root: &Path) -> String {
    let raw = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let sanitized: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(|c| c == '-' || c == '.');
    if trimmed.is_empty() {
        "workspace".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The path rule, applied per component.
fn path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)(^\.env($|\.)|credentials|secrets?|\.pem$|\.key$|\.p12$|\.pfx$|\.tfstate|\
              id_rsa|id_ed25519|\.sqlite|\.db$|\.log$|dump|customer[_-]?data)",
        )
        .expect("path pattern is valid")
    })
}

/// Content rules, matched over the whole file. Every pattern is a credential
/// or private-data shape; a confirmed match excludes the file entirely.
fn rules() -> &'static [(&'static str, Regex)] {
    static RULES: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    RULES.get_or_init(|| {
        const PATTERNS: &[(&str, &str)] = &[
            ("private_key", r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
            ("jwt", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
            (
                "provider_token",
                r"\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})",
            ),
            (
                "credential_literal",
                r#"(?i)["'`]?\b(?:password|passwd|pwd|api[_-]?key|access[_-]?key|secret|token|authorization|client[_-]?secret)["'`]?\s*(?::=|[:=])\s*["'`][^"'`\n]{4,}["'`]"#,
            ),
            (
                "credential_yaml",
                r"(?im)^\s*(?:password|passwd|api[_-]?key|secret|token|client[_-]?secret)\s*:\s*\S+",
            ),
            (
                "credential_url",
                r"(?i)(?:https?|postgres(?:ql)?|mysql|redis|mongodb)://[^\s/]+:[^\s/@]+@|[?&](?:token|key|secret|password|signature|credential)=[^&\s]+",
            ),
            ("kubernetes_secret", r#"(?im)^\s*kind\s*:\s*["']?Secret["']?\s*$"#),
            ("kubernetes_secret_json", r#"(?i)["']kind["']\s*:\s*["']Secret["']"#),
            ("uuid_literal", r"\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b"),
            ("email_literal", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
            ("opaque_literal", r#"["'][A-Za-z0-9+/=_-]{32,}["']"#),
            (
                "customer_literal",
                r#"(?i)["']?(?:customer[_-]?id|account[_-]?(?:id|number)|card[_-]?number|phone|email|merchant[_-]?id)["']?\s*[:=]\s*(?:["'][^"'\n]+["']|\d{5,})"#,
            ),
            ("environment_value", r"(?m)^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*\S+"),
            ("sql_data", r"(?i)\b(?:INSERT\s+INTO|COPY\s+\S+\s+FROM)\b"),
        ];
        PATTERNS.iter()
            .map(|(rule, pattern)| (*rule, Regex::new(pattern).expect("scanner pattern is valid")))
            .collect()
    })
}

/// Every rule match in `content`, as `(rule, 1-based line)`.
fn findings_in(content: &str) -> Vec<(&'static str, usize)> {
    let mut found = Vec::new();
    for (rule, pattern) in rules() {
        for matched in pattern.find_iter(content) {
            let line = content[..matched.start()]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count()
                + 1;
            found.push((*rule, line));
        }
    }
    found
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), MemoryError> {
    let mut body = serde_json::to_vec_pretty(value)
        .map_err(|e| MemoryError::Internal(format!("serialise scan artifact: {e}")))?;
    body.push(b'\n');
    fs_util::atomic_write(path, &body)?;
    Ok(())
}

fn write_jsonl<T: Serialize>(path: &Path, records: &[T]) -> Result<(), MemoryError> {
    let mut body = String::new();
    for record in records {
        body.push_str(
            &serde_json::to_string(record)
                .map_err(|e| MemoryError::Internal(format!("serialise scan manifest: {e}")))?,
        );
        body.push('\n');
    }
    fs_util::atomic_write(path, body.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Commit every file in `dir` and return the new commit ID.
    fn commit_all(dir: &Path, message: &str) -> String {
        let repo = git2::Repository::open(dir).expect("open repo");
        let mut index = repo.index().expect("index");
        index
            .add_all(["."], git2::IndexAddOption::DEFAULT, None)
            .expect("stage files");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = git2::Signature::now("Test", "test@example.invalid").expect("signature");
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .expect("commit")
        .to_string()
    }

    fn repo_with(dir: &Path) -> git2::Repository {
        git2::Repository::init(dir).expect("init repo")
    }

    fn scan(dir: &Path) -> RepositoryScanSummary {
        scan_repositories(&RepositoryScanOptions::new(dir).expect("options")).expect("scan")
    }

    #[test]
    fn scan_writes_manifest_with_git_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").expect("write main");
        fs::write(dir.path().join("README.md"), "# Demo\n").expect("write readme");
        let commit = commit_all(dir.path(), "initial import");

        let summary = scan(dir.path());

        assert_eq!(summary.repositories, 1);
        assert_eq!(summary.accepted_files, 2, "both clean files are accepted");
        assert_eq!(summary.selected, 2);

        let report: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&summary.security_report).expect("report"))
                .expect("parse report");
        assert_eq!(report["repositories"], 1);
        assert_eq!(report["accepted_files"], 2);
        assert_eq!(report["findings"].as_array().expect("findings").len(), 0);

        let manifest = fs::read_to_string(&summary.manifest).expect("manifest");
        let records: Vec<serde_json::Value> = manifest
            .lines()
            .map(|line| serde_json::from_str(line).expect("record"))
            .collect();
        assert_eq!(records.len(), 2);
        let main = records
            .iter()
            .find(|record| record["path"] == "src/main.rs")
            .expect("main.rs record");
        assert_eq!(main["repo"], repo_name(dir.path()));
        assert_eq!(main["language"], "rust");
        assert_eq!(main["commit"], commit);
        assert_eq!(main["commit_messages"][0], "initial import");
        assert_eq!(main["content_hash"], content_hash("fn main() {}\n"));
        assert_eq!(main["blame"].as_array().expect("blame").len(), 0);
    }

    #[test]
    fn scan_excludes_sensitive_paths_and_never_echoes_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        fs::write(dir.path().join("src/app.rs"), "fn run() {}\n").expect("write app");
        fs::write(dir.path().join(".env"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n").expect("write env");
        fs::create_dir_all(dir.path().join("config")).expect("mkdir config");
        fs::write(
            dir.path().join("config/credentials.json"),
            "{\"token\": \"placeholder\"}\n",
        )
        .expect("write credentials");
        fs::write(
            dir.path().join("src/leaky.rs"),
            "let token = \"ghp_0123456789012345678901234567890123\";\n",
        )
        .expect("write leaky");
        commit_all(dir.path(), "initial import");

        let summary = scan(dir.path());

        assert_eq!(
            summary.accepted_files, 1,
            "only the clean source file reaches the manifest"
        );
        assert_eq!(
            summary.findings, 5,
            "two path exclusions plus three content rules are reported"
        );

        let report = fs::read_to_string(&summary.security_report).expect("report");
        assert!(report.contains("excluded_path"));
        assert!(report.contains("provider_token"));
        assert!(
            !report.contains("AKIAABCDEFGHIJKLMNOP"),
            "the report must locate a finding without storing the value"
        );
        assert!(
            !report.contains("ghp_0123456789012345678901234567890123"),
            "the report must never echo a token"
        );

        let manifest = fs::read_to_string(&summary.manifest).expect("manifest");
        assert!(manifest.contains("src/app.rs"));
        assert!(!manifest.contains(".env"));
        assert!(!manifest.contains("leaky.rs"));
    }

    #[test]
    fn scan_limit_truncates_the_manifest_but_not_the_report() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        for name in ["c.txt", "a.txt", "b.txt"] {
            fs::write(dir.path().join(name), "text\n").expect("write");
        }
        commit_all(dir.path(), "three files");

        let options = RepositoryScanOptions::new(dir.path())
            .expect("options")
            .with_limit(1);
        let summary = scan_repositories(&options).expect("scan");

        assert_eq!(summary.accepted_files, 3, "the whole workspace is scanned");
        assert_eq!(summary.selected, 1);
        let manifest = fs::read_to_string(&summary.manifest).expect("manifest");
        assert_eq!(manifest.lines().count(), 1);
        assert!(manifest.contains("a.txt"), "the prefix starts at a.txt");
    }

    #[test]
    fn workspace_without_a_repository_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("loose.txt"), "text\n").expect("write");

        let options = RepositoryScanOptions::new(dir.path()).expect("options");
        let error = scan_repositories(&options).expect_err("a plain directory is not a repository");
        assert!(
            error.to_string().contains("not a git repository"),
            "the error names the problem: {error}"
        );
        assert!(
            !dir.path().join(DEFAULT_ARTIFACTS_DIR).exists(),
            "a rejected workspace writes no artifacts"
        );
    }

    #[test]
    fn scan_does_not_follow_nested_repositories() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::write(dir.path().join("top.txt"), "top\n").expect("write top");
        commit_all(dir.path(), "top level");

        // A nested checkout has its own HEAD and its own file; neither belongs
        // in this workspace's manifest.
        let nested = dir.path().join("nested");
        fs::create_dir(&nested).expect("mkdir nested");
        repo_with(&nested);
        fs::write(nested.join("inner.txt"), "inner\n").expect("write inner");
        commit_all(&nested, "nested import");

        let summary = scan(dir.path());

        assert_eq!(summary.repositories, 1);
        assert_eq!(summary.accepted_files, 1, "only the workspace's own file");
        let manifest = fs::read_to_string(&summary.manifest).expect("manifest");
        assert!(manifest.contains("top.txt"));
        assert!(
            !manifest.contains("inner.txt"),
            "nested repositories are not scanned"
        );
    }

    #[test]
    fn blame_records_only_commit_ids_and_line_numbers() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::write(dir.path().join("notes.md"), "line one\nline two\n").expect("write");
        let commit = commit_all(dir.path(), "notes");

        let options = RepositoryScanOptions::new(dir.path())
            .expect("options")
            .with_blame(true);
        let summary = scan_repositories(&options).expect("scan");

        let manifest = fs::read_to_string(&summary.manifest).expect("manifest");
        let record: serde_json::Value = serde_json::from_str(manifest.trim()).expect("record");
        let blame = record["blame"].as_array().expect("blame");
        assert_eq!(blame.len(), 2);
        assert_eq!(blame[0]["commit"], commit);
        assert_eq!(blame[0]["line"], 1);
        assert_eq!(blame[1]["line"], 2);
        assert!(
            !manifest.contains("test@example.invalid"),
            "author identity is never persisted"
        );
    }

    #[test]
    fn scan_skips_ignored_and_generated_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").expect("write ignore");
        fs::write(
            dir.path().join("generated.rs"),
            "// DO NOT EDIT — generated\nfn generated() {}\n",
        )
        .expect("write generated");
        commit_all(dir.path(), "setup");
        // The ignored file is created after the commit, so it can only be
        // listed as an untracked entry that git's ignore rules must exclude.
        fs::write(dir.path().join("ignored.txt"), "ignored\n").expect("write ignored");

        let summary = scan(dir.path());

        let manifest = fs::read_to_string(&summary.manifest).expect("manifest");
        assert!(!manifest.contains("ignored.txt"), "gitignore is honoured");
        assert!(
            !manifest.contains("generated.rs"),
            "generated files are skipped"
        );
        assert!(manifest.contains(".gitignore"));
    }

    #[test]
    fn scan_writes_insights_artifact_and_memory_digest() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::create_dir_all(dir.path().join("src")).expect("mkdir src");
        fs::create_dir_all(dir.path().join("tests")).expect("mkdir tests");
        fs::write(
            dir.path().join("src/main.rs"),
            "// TODO: refactor\nfn main() {}\n",
        )
        .expect("write main");
        fs::write(dir.path().join("README.md"), "# Demo\n").expect("write readme");
        fs::write(dir.path().join("tests/app_test.rs"), "fn check() {}\n").expect("write test");
        commit_all(dir.path(), "initial import");

        let summary = scan(dir.path());

        let insights: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&summary.insights).expect("insights"))
                .expect("parse insights");
        assert_eq!(insights["files"], 3);
        assert_eq!(insights["test_files"], 1);
        assert_eq!(insights["markers"][0]["marker"], "TODO");
        assert_eq!(insights["markers"][0]["count"], 1);
        assert!(
            insights["languages"]
                .as_array()
                .expect("languages")
                .iter()
                .any(|language| language["language"] == "rust")
        );
        assert!(
            insights["areas"]
                .as_array()
                .expect("areas")
                .iter()
                .any(|area| area["path"] == "src")
        );
        assert!(
            insights["project_files"]
                .as_array()
                .expect("project files")
                .iter()
                .any(|file| file == "README.md")
        );
        assert!(summary.insights_markdown.contains("# Codebase insights"));
        assert!(summary.insights_markdown.contains("TODO 1"));
    }

    #[test]
    fn insights_ignore_excluded_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        repo_with(dir.path());
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").expect("write");
        fs::write(dir.path().join(".env"), "TOKEN=supersecret\n").expect("write env");
        commit_all(dir.path(), "setup");

        let summary = scan(dir.path());
        let insights = fs::read_to_string(&summary.insights).expect("insights");
        assert_eq!(summary.accepted_files, 1);
        assert!(
            !insights.contains(".env"),
            "sensitive paths never reach the insights"
        );
        assert!(!summary.insights_markdown.contains(".env"));
    }

    #[tokio::test]
    async fn save_insights_creates_and_updates_one_memory() {
        let dir = tempfile::tempdir().expect("tempdir");
        save_insights(dir.path(), "demo", "# Digest\n")
            .await
            .expect("save");

        let scope_dir = dir.path().join("projects/demo");
        let path = scope_dir.join(format!("{INSIGHTS_MEMORY_NAME}.md"));
        assert!(path.exists(), "the memory file is written");
        let body = fs::read_to_string(&path).expect("read memory");
        assert!(body.contains("# Digest"));
        assert!(
            body.contains("codebase-insights"),
            "saved as a tagged memory"
        );

        save_insights(dir.path(), "demo", "# Digest v2\n")
            .await
            .expect("update");
        let entries: Vec<_> = fs::read_dir(&scope_dir)
            .expect("scope dir")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(entries.len(), 1, "re-saving updates the same memory");
        assert!(fs::read_to_string(&path).expect("read").contains("v2"));

        let git = git2::Repository::open(dir.path()).expect("git memory repo");
        let head = git.head().expect("head").peel_to_commit().expect("commit");
        assert!(
            head.tree()
                .expect("tree")
                .get_path(Path::new("projects/demo/codebase-insights.md"))
                .is_ok(),
            "the memory is committed to the git repository, not just written"
        );
    }

    #[test]
    fn default_scope_sanitizes_to_scope_path_characters() {
        assert_eq!(default_scope(Path::new("/work/my-repo")), "my-repo");
        assert_eq!(default_scope(Path::new("/work/my repo!")), "my-repo");
        assert_eq!(default_scope(Path::new("/")), "workspace");
    }

    #[test]
    fn rules_flag_credentials_and_accept_clean_source() {
        assert!(rules().iter().any(|(rule, _)| *rule == "provider_token"));
        assert!(!findings_in("key = \"ghp_0123456789012345678901234567890123\"").is_empty());
        assert!(
            findings_in("postgres://user:password@example.invalid/db")
                .iter()
                .any(|(rule, _)| *rule == "credential_url")
        );
        assert!(
            findings_in("fn clean() {}\n").is_empty(),
            "ordinary source has no findings"
        );
    }
    /// Untracked enumeration pins the git2 status semantics the scanner
    /// relies on: untracked files are listed, ignored files are excluded, and
    /// untracked directories are expanded to the files inside them.
    #[test]
    fn untracked_enumeration_expands_dirs_and_skips_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = repo_with(dir.path());
        fs::write(dir.path().join(".gitignore"), "ignored.txt\n").expect("write gitignore");
        fs::write(dir.path().join("tracked.txt"), "tracked\n").expect("write tracked");
        commit_all(dir.path(), "tracked baseline");

        // Created after the commit, so they are untracked, not tracked.
        fs::write(dir.path().join("untracked.txt"), "new\n").expect("write untracked");
        fs::create_dir_all(dir.path().join("newdir")).expect("mkdir newdir");
        fs::write(dir.path().join("newdir/nested.txt"), "nested\n").expect("write nested");
        fs::write(dir.path().join("ignored.txt"), "ignored\n").expect("write ignored");

        let paths = list_paths(&repo).expect("list_paths");

        assert_eq!(
            paths,
            BTreeSet::from([
                ".gitignore".to_string(),
                "newdir/nested.txt".to_string(),
                "tracked.txt".to_string(),
                "untracked.txt".to_string(),
            ]),
            "ignored files stay out and untracked directories expand to their files"
        );
    }
}
