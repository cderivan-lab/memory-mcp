//! Workspace bootstrap — scan a directory, embed its text files into a local
//! vector index, and write a chunk dataset.
//!
//! The workspace is treated as read-only source material. The only directory
//! these operations write to is the artifacts directory (default `.pali/`),
//! which scans skip so repeated runs do not index their own output. Artifacts
//! are derived data: deleting them and running the commands again rebuilds
//! the same result.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{
    embedding::EmbeddingBackend,
    error::MemoryError,
    index::{UsearchStore, VectorStore},
    types::Scope,
};

/// Default maximum size of a file included in a scan.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Maximum number of source lines in one chunk.
const MAX_CHUNK_LINES: usize = 80;
/// Maximum number of characters in one chunk, when lines are very long.
const MAX_CHUNK_CHARS: usize = 4_000;
/// Lines repeated at the start of the next chunk, to keep context across cuts.
const CHUNK_OVERLAP_LINES: usize = 8;
/// Chunks embedded in one backend call.
const EMBED_BATCH_SIZE: usize = 32;
/// Bytes inspected when deciding whether a file is binary.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Default artifacts directory, relative to the workspace root.
const DEFAULT_ARTIFACTS_DIR: &str = ".pali";

/// Directories that never contain source worth indexing.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".pali",
    ".cache",
    ".gradle",
    ".idea",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    ".vscode-test",
    "__pycache__",
    "bin",
    "build",
    "coverage",
    "DerivedData",
    "dist",
    "models",
    "node_modules",
    "obj",
    "out",
    "Pods",
    "target",
    "test-resources",
    "vendor",
    "venv",
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Inputs shared by scan, index, and dataset.
///
/// Construct with [`ScanOptions::new`], which resolves and validates the
/// workspace root, then chain the optional settings.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    root: PathBuf,
    artifacts: Option<PathBuf>,
    limit: Option<usize>,
    max_file_bytes: u64,
}

impl ScanOptions {
    /// Resolve `root` as a workspace directory.
    ///
    /// The path is canonicalized (symlinks and `..` resolved) so reported file
    /// paths and artifact locations are stable regardless of how the caller
    /// spelled the directory.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, MemoryError> {
        let root = crate::fs_util::canonicalize_allow_missing(&root.into())?;
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
        })
    }

    /// Set the artifacts directory. A relative path resolves against the
    /// workspace root; the default is `<workspace>/.pali`.
    #[must_use]
    pub fn with_artifacts(mut self, dir: impl Into<PathBuf>) -> Self {
        self.artifacts = Some(dir.into());
        self
    }

    /// Bound the number of scanned files. Files are sorted by path first, so
    /// a sample is deterministic; later scans use the same prefix.
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

// ---------------------------------------------------------------------------
// Public summaries
// ---------------------------------------------------------------------------

/// Result of a scan. The full file inventory and findings are written to
/// [`ScanSummary::report`]; this summary is what the CLI prints.
#[derive(Debug, Serialize)]
pub struct ScanSummary {
    /// Number of text files discovered.
    pub files: usize,
    /// Total size of the discovered files in bytes.
    pub bytes: u64,
    /// Directory entries skipped (dependency/build directories, binaries,
    /// oversized files, symlinks, unreadable entries).
    pub skipped: usize,
    /// Files whose contents are withheld from chunking because they commonly
    /// carry credentials.
    pub sensitive: usize,
    /// Number of potential secrets found. Values are never recorded.
    pub findings: usize,
    /// Path of the full JSON report.
    pub report: String,
}

/// Result of indexing a workspace.
#[derive(Debug, Serialize)]
pub struct IndexSummary {
    /// Number of files that contributed chunks.
    pub files: usize,
    /// Number of chunks embedded and stored.
    pub chunks: usize,
    /// Files skipped because they commonly carry credentials.
    pub sensitive_skipped: usize,
    /// Embedding dimensions of the persisted index.
    pub dimensions: usize,
    /// Directory holding the index and its chunk manifest.
    pub index: String,
}

/// Result of writing a chunk dataset.
#[derive(Debug, Serialize)]
pub struct DatasetSummary {
    /// Number of files that contributed chunks.
    pub files: usize,
    /// Number of JSONL records written.
    pub chunks: usize,
    /// Files skipped because they commonly carry credentials.
    pub sensitive_skipped: usize,
    /// Path of the JSONL dataset.
    pub output: String,
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/// A text file included in a scan.
#[derive(Debug, Serialize)]
pub struct ScannedFile {
    /// Workspace-relative path, `/`-separated.
    path: String,
    /// Coarse language label derived from the extension.
    language: String,
    /// File size in bytes.
    bytes: u64,
    /// Number of lines in the file.
    lines: usize,
    /// Whether contents must be withheld from chunking.
    sensitive: bool,
}

/// A potential secret, located by path and line. The matched value is never
/// stored.
#[derive(Debug, Serialize)]
pub(crate) struct Finding {
    path: String,
    line: usize,
    rule: &'static str,
}

/// Full scan inventory written to the report file.
#[derive(Debug, Serialize)]
pub struct Report {
    root: String,
    files: Vec<ScannedFile>,
    skipped: usize,
    findings: Vec<Finding>,
}

/// Scan a workspace and write its inventory to `<artifacts>/scan.json`.
///
/// Directories in [`SKIP_DIRS`], the artifacts directory, symlinks, files
/// larger than the configured maximum, binary files, and files that are not
/// valid UTF-8 are skipped. Files that commonly hold credentials are listed
/// (and scanned for findings) but marked sensitive, so index and dataset never
/// emit their contents.
pub fn scan(options: &ScanOptions) -> Result<ScanSummary, MemoryError> {
    let report = scan_workspace(options)?;

    let artifacts = options.artifacts_dir();
    std::fs::create_dir_all(&artifacts)?;
    let report_path = artifacts.join("scan.json");
    let json = serde_json::to_vec_pretty(&report)
        .map_err(|e| MemoryError::Internal(format!("serialise scan report: {e}")))?;
    crate::fs_util::atomic_write(&report_path, &json)?;

    Ok(ScanSummary {
        files: report.files.len(),
        bytes: report.files.iter().map(|f| f.bytes).sum(),
        skipped: report.skipped,
        sensitive: report.files.iter().filter(|f| f.sensitive).count(),
        findings: report.findings.len(),
        report: report_path.display().to_string(),
    })
}

/// Scan a workspace and return its inventory without writing any artifact.
///
/// This is the shared entry point: [`scan`], [`index`], [`dataset`], and the
/// repository scanner all consume it, so the filesystem walk, the binary and
/// UTF-8 checks, and the credential rules live in exactly one place.
pub fn scan_workspace(options: &ScanOptions) -> Result<Report, MemoryError> {
    let _span = tracing::info_span!("workspace.scan", root = %options.root.display()).entered();

    let mut files = Vec::new();
    let mut findings = Vec::new();
    let mut skipped = 0usize;
    walk(
        &options.root,
        &options.root,
        options,
        &mut files,
        &mut findings,
        &mut skipped,
    )?;

    files.sort_by(|a, b| a.path.cmp(&b.path));
    findings.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));

    if let Some(limit) = options.limit
        && files.len() > limit
    {
        files.truncate(limit);
        let kept: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
        findings.retain(|f| kept.contains(f.path.as_str()));
    }

    Ok(Report {
        root: options.root.display().to_string(),
        files,
        skipped,
        findings,
    })
}

/// Scan a workspace and return only the accepted file inventory.
///
/// This is the shared entry point for [`scan`], [`index`], [`dataset`], and
/// the repository scanner. It performs the filesystem walk, binary and UTF-8
/// checks, and credential rules in exactly one place; callers that only need
/// the file list call this instead of duplicating the traversal.
pub fn scan_files(options: &ScanOptions) -> Result<Vec<ScannedFile>, MemoryError> {
    Ok(scan_workspace(options)?.files)
}

pub(crate) fn walk(
    root: &Path,
    dir: &Path,
    options: &ScanOptions,
    files: &mut Vec<ScannedFile>,
    findings: &mut Vec<Finding>,
    skipped: &mut usize,
) -> Result<(), MemoryError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if dir != root => {
            tracing::warn!(path = %dir.display(), error = %e, "skipping unreadable directory");
            *skipped += 1;
            return Ok(());
        }
        Err(e) => {
            return Err(e.into());
        }
    };

    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping unreadable entry");
                *skipped += 1;
                continue;
            }
        };

        if file_type.is_symlink() {
            *skipped += 1;
            continue;
        }

        if file_type.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if SKIP_DIRS.contains(&name.as_ref()) || path == options.artifacts_dir() {
                *skipped += 1;
                continue;
            }
            walk(root, &path, options, files, findings, skipped)?;
            continue;
        }

        if !file_type.is_file() {
            *skipped += 1;
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping unreadable metadata");
                *skipped += 1;
                continue;
            }
        };
        if metadata.len() == 0 || metadata.len() > options.max_file_bytes {
            *skipped += 1;
            continue;
        }

        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping unreadable file");
                *skipped += 1;
                continue;
            }
        };
        if is_binary(&bytes) {
            *skipped += 1;
            continue;
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };

        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let sensitive = is_sensitive(relative.as_ref());
        let language = language(relative.as_ref()).to_string();

        for (index, line) in text.lines().enumerate() {
            if let Some(rule) = secret_rule(line) {
                findings.push(Finding {
                    path: relative.clone(),
                    line: index + 1,
                    rule,
                });
            }
        }

        files.push(ScannedFile {
            path: relative,
            language,
            bytes: metadata.len(),
            lines: text.lines().count(),
            sensitive,
        });
    }

    Ok(())
}

/// A file is binary when a NUL byte appears in its leading bytes.
pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0)
}

/// Detect high-signal credential formats by shape, without validating them.
pub(crate) fn secret_rule(line: &str) -> Option<&'static str> {
    if line.contains("PRIVATE KEY-----") && line.contains("BEGIN") {
        return Some("private-key");
    }
    if has_token(line, "AKIA", 16, |c| {
        c.is_ascii_uppercase() || c.is_ascii_digit()
    }) {
        return Some("aws-access-key");
    }
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if has_token(line, prefix, 30, |c| c.is_ascii_alphanumeric()) {
            return Some("github-token");
        }
    }
    for prefix in ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"] {
        if has_token(line, prefix, 10, |c| c.is_ascii_alphanumeric() || c == '-') {
            return Some("slack-token");
        }
    }
    None
}

/// True when `line` contains `prefix` followed by at least `min` characters
/// accepted by `allowed`.
fn has_token(line: &str, prefix: &str, min: usize, allowed: fn(char) -> bool) -> bool {
    let mut rest = line;
    while let Some(index) = rest.find(prefix) {
        let after = &rest[index + prefix.len()..];
        if after.chars().take_while(|c| allowed(*c)).count() >= min {
            return true;
        }
        rest = after;
    }
    false
}

/// Files whose contents must never reach an index or dataset.
pub(crate) fn is_sensitive(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let lower = file_name.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map_or("", |(_, ext)| ext);

    if lower == ".env" {
        return true;
    }
    if lower.starts_with(".env.")
        && !matches!(
            lower.as_str(),
            ".env.example" | ".env.sample" | ".env.template" | ".env.dist"
        )
    {
        return true;
    }

    matches!(
        extension,
        "pem" | "key" | "p12" | "pfx" | "jks" | "keystore"
    ) || matches!(
        lower.as_str(),
        ".netrc" | ".npmrc" | ".pypirc" | "credentials" | "credentials.json"
    ) || lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.starts_with("id_dsa")
        || lower.contains("credential")
        || lower.contains("secret")
}

/// Coarse language label from the file extension.
pub(crate) fn language(path: &str) -> &'static str {
    let Some((_, extension)) = path.rsplit_once('.') else {
        return "text";
    };
    match extension.to_ascii_lowercase().as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "m" | "mm" => "objective-c",
        "scala" => "scala",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" => "powershell",
        "sql" => "sql",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "vue" => "vue",
        "svelte" => "svelte",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "ini" | "cfg" | "conf" => "config",
        "xml" => "xml",
        "proto" => "protobuf",
        "graphql" | "gql" => "graphql",
        "tex" => "latex",
        "r" => "r",
        "lua" => "lua",
        "dart" => "dart",
        "ex" | "exs" => "elixir",
        "hs" => "haskell",
        "ml" | "mli" => "ocaml",
        "clj" | "cljs" => "clojure",
        "zig" => "zig",
        "sol" => "solidity",
        _ => "text",
    }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/// One retrieval chunk, serialised into the dataset and the index manifest.
#[derive(Debug, Serialize)]
struct ChunkRecord {
    id: String,
    path: String,
    language: String,
    start_line: usize,
    end_line: usize,
    text: String,
}

/// Read every non-sensitive scanned file and split it into chunks.
///
/// Returns the chunks and the number of sensitive files skipped. A file that
/// disappeared since the scan is skipped with a warning; an index or dataset
/// should not fail because a build removed a generated file.
fn chunk_workspace(
    report: &Report,
    options: &ScanOptions,
) -> Result<(Vec<ChunkRecord>, usize), MemoryError> {
    let _span = tracing::info_span!("workspace.chunk", files = report.files.len()).entered();

    let mut chunks: Vec<ChunkRecord> = Vec::new();
    let mut sensitive_skipped = 0usize;

    for file in &report.files {
        if file.sensitive {
            sensitive_skipped += 1;
            continue;
        }
        let content = match std::fs::read_to_string(options.root.join(&file.path)) {
            Ok(content) => content,
            Err(e) => {
                tracing::warn!(path = %file.path, error = %e, "skipping file that changed since the scan");
                continue;
            }
        };
        chunks.extend(chunk_file(file, &content));
    }

    Ok((chunks, sensitive_skipped))
}

/// Split `content` into line-bounded chunks with a small overlap.
fn chunk_file(file: &ScannedFile, content: &str) -> Vec<ChunkRecord> {
    let lines: Vec<&str> = content.lines().collect();
    let mut chunks = Vec::new();
    let mut start = 0usize;

    while start < lines.len() {
        let mut end = start;
        let mut chars = 0usize;
        while end < lines.len() && end - start < MAX_CHUNK_LINES {
            let line_chars = lines[end].chars().count() + 1;
            if end > start && chars + line_chars > MAX_CHUNK_CHARS {
                break;
            }
            chars += line_chars;
            end += 1;
        }
        // A single line longer than the character cap still gets one chunk.
        if end == start {
            end += 1;
        }

        let text = lines[start..end].join("\n");
        if !text.trim().is_empty() {
            let start_line = start + 1;
            chunks.push(ChunkRecord {
                id: format!("{}:{start_line}-{end}", file.path),
                path: file.path.clone(),
                language: file.language.clone(),
                start_line,
                end_line: end,
                text,
            });
        }

        if end >= lines.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP_LINES).max(start + 1);
    }

    chunks
}

fn distinct_files(chunks: &[ChunkRecord]) -> usize {
    let mut paths = HashSet::new();
    for chunk in chunks {
        paths.insert(chunk.path.as_str());
    }
    paths.len()
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/// Embed every chunk of a workspace and persist a usearch index under
/// `<artifacts>/index`, alongside `chunks.jsonl` describing each vector.
///
/// Indexing a workspace requires the embedding model to be provisioned (see
/// `scripts/fetch-model.sh`); a missing model fails before any file is walked.
pub async fn index(
    options: &ScanOptions,
    embedding: &dyn EmbeddingBackend,
) -> Result<IndexSummary, MemoryError> {
    let _span = tracing::info_span!("workspace.index").entered();

    let report = scan_workspace(options)?;
    let (chunks, sensitive_skipped) = chunk_workspace(&report, options)?;

    let dimensions = embedding.dimensions();
    let store = UsearchStore::new(dimensions)?;

    for batch in chunks.chunks(EMBED_BATCH_SIZE) {
        let texts: Vec<String> = batch.iter().map(|chunk| chunk.text.clone()).collect();
        let vectors = embedding.embed(&texts).await?;
        if vectors.len() != batch.len() {
            return Err(MemoryError::Embedding(format!(
                "embedding returned {} vectors for {} chunks",
                vectors.len(),
                batch.len()
            )));
        }
        for (chunk, vector) in batch.iter().zip(vectors) {
            if vector.len() != dimensions {
                return Err(MemoryError::Embedding(format!(
                    "embedding returned {} dimensions, expected {dimensions}",
                    vector.len()
                )));
            }
            store.add(&Scope::Root, &vector, format!("workspace/{}", chunk.id))?;
        }
    }

    let index_dir = options.artifacts_dir().join("index");
    store.save(&index_dir)?;
    write_jsonl(&index_dir.join("chunks.jsonl"), &chunks)?;

    Ok(IndexSummary {
        files: distinct_files(&chunks),
        chunks: chunks.len(),
        sensitive_skipped,
        dimensions,
        index: index_dir.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

/// Write workspace chunks as JSONL records.
///
/// `output` defaults to `<artifacts>/dataset.jsonl`; a relative path resolves
/// against the workspace root. Sensitive files never contribute records.
pub fn dataset(
    options: &ScanOptions,
    output: Option<&Path>,
) -> Result<DatasetSummary, MemoryError> {
    let _span = tracing::info_span!("workspace.dataset").entered();

    let report = scan_workspace(options)?;
    let (chunks, sensitive_skipped) = chunk_workspace(&report, options)?;

    let output_path = match output {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(path) => options.root.join(path),
        None => options.artifacts_dir().join("dataset.jsonl"),
    };
    write_jsonl(&output_path, &chunks)?;

    Ok(DatasetSummary {
        files: distinct_files(&chunks),
        chunks: chunks.len(),
        sensitive_skipped,
        output: output_path.display().to_string(),
    })
}

fn write_jsonl<T: Serialize>(path: &Path, records: &[T]) -> Result<(), MemoryError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut body = String::new();
    for record in records {
        body.push_str(
            &serde_json::to_string(record)
                .map_err(|e| MemoryError::Internal(format!("serialise record: {e}")))?,
        );
        body.push('\n');
    }
    crate::fs_util::atomic_write(path, body.as_bytes())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct FixedEmbedding;

    #[async_trait::async_trait]
    impl EmbeddingBackend for FixedEmbedding {
        async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, MemoryError> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0, 0.0]).collect())
        }

        fn dimensions(&self) -> usize {
            3
        }
    }

    #[test]
    fn scan_marks_sensitive_files_and_never_echoes_secret_values() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").expect("write main");
        fs::write(dir.path().join(".env"), "AWS_KEY=AKIAABCDEFGHIJKLMNOP\n").expect("write env");
        fs::create_dir_all(dir.path().join("node_modules/pkg")).expect("mkdir");
        fs::write(dir.path().join("node_modules/pkg/index.js"), "ignored\n").expect("write dep");

        let options = ScanOptions::new(dir.path()).expect("options");
        let summary = scan(&options).expect("scan");

        assert_eq!(
            summary.files, 2,
            "source file and sensitive file are listed"
        );
        assert_eq!(summary.sensitive, 1);
        assert_eq!(summary.findings, 1, "the AWS-shaped key is reported");

        let report = fs::read_to_string(&summary.report).expect("read report");
        assert!(report.contains("main.rs"));
        assert!(report.contains("aws-access-key"));
        assert!(
            !report.contains("AKIAABCDEFGHIJKLMNOP"),
            "the report must locate a finding without storing the value"
        );
        assert!(
            !report.contains("node_modules"),
            "dependency directories are not scanned"
        );
    }

    #[test]
    fn scan_limit_is_a_deterministic_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["c.txt", "a.txt", "b.txt"] {
            fs::write(dir.path().join(name), "text\n").expect("write");
        }

        let options = ScanOptions::new(dir.path()).expect("options").with_limit(2);
        let summary = scan(&options).expect("scan");
        assert_eq!(summary.files, 2);

        let report: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(summary.report).expect("read report"))
                .expect("parse report");
        let paths: Vec<&str> = report["files"]
            .as_array()
            .expect("files array")
            .iter()
            .map(|file| file["path"].as_str().expect("path"))
            .collect();
        assert_eq!(paths, ["a.txt", "b.txt"]);
    }

    #[test]
    fn chunks_cover_lines_with_overlap_and_keep_spans() {
        let content = (1..=100)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let file = ScannedFile {
            path: "src/long.rs".to_string(),
            language: "rust".to_string(),
            bytes: content.len() as u64,
            lines: 100,
            sensitive: false,
        };

        let chunks = chunk_file(&file, &content);
        assert_eq!(chunks.len(), 2, "100 lines split into two 80-line chunks");
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 80));
        assert_eq!(
            (chunks[1].start_line, chunks[1].end_line),
            (73, 100),
            "the second chunk repeats the overlap lines"
        );
        assert_eq!(chunks[1].id, "src/long.rs:73-100");
        assert!(chunks[1].text.starts_with("line 73"));
    }

    #[test]
    fn dataset_writes_jsonl_and_withholds_sensitive_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("docs")).expect("mkdir");
        fs::write(dir.path().join("docs/notes.md"), "remember this\n").expect("write doc");
        fs::write(dir.path().join(".env"), "TOKEN=supersecret\n").expect("write env");

        let options = ScanOptions::new(dir.path()).expect("options");
        let output = dir.path().join("out/dataset.jsonl");
        let summary = dataset(&options, Some(&output)).expect("dataset");

        assert_eq!(summary.chunks, 1);
        assert_eq!(summary.files, 1);
        assert_eq!(summary.sensitive_skipped, 1);

        let body = fs::read_to_string(&output).expect("read dataset");
        assert!(
            !body.contains("supersecret"),
            "sensitive contents are withheld"
        );
        let record: serde_json::Value = serde_json::from_str(body.trim()).expect("parse record");
        assert_eq!(record["path"], "docs/notes.md");
        assert_eq!(record["language"], "markdown");
        assert_eq!(record["start_line"], 1);
        assert_eq!(record["text"], "remember this");
    }

    #[tokio::test]
    async fn index_persists_searchable_names_and_chunk_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("main.rs"), "fn main() {}\n").expect("write");
        fs::write(dir.path().join(".env"), "TOKEN=supersecret\n").expect("write env");

        let options = ScanOptions::new(dir.path()).expect("options");
        let summary = index(&options, &FixedEmbedding).await.expect("index");

        assert_eq!(summary.chunks, 1);
        assert_eq!(summary.files, 1);
        assert_eq!(summary.sensitive_skipped, 1);
        assert_eq!(summary.dimensions, 3);
        assert!(Path::new(&summary.index).join("all/index.usearch").exists());
        assert!(Path::new(&summary.index).join("chunks.jsonl").exists());

        let store =
            UsearchStore::load(Path::new(&summary.index), 3).expect("reload persisted index");
        assert!(
            store.find_by_name("workspace/main.rs:1-1").is_some(),
            "the chunk is addressable in the persisted index"
        );
    }

    #[test]
    fn scan_skips_an_explicit_artifacts_directory_inside_the_workspace() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("a.txt"), "a\n").expect("write");
        fs::create_dir_all(dir.path().join("build-artifacts")).expect("mkdir");
        fs::write(dir.path().join("build-artifacts/scan.json"), "{}\n").expect("write");

        let options = ScanOptions::new(dir.path())
            .expect("options")
            .with_artifacts("build-artifacts");
        let summary = scan(&options).expect("scan");

        assert_eq!(summary.files, 1, "only the source file is scanned");
        let report = fs::read_to_string(summary.report).expect("read report");
        assert!(!report.contains("build-artifacts/scan.json"));
    }
}
