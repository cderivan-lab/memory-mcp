//! Thin CLI wrapper around the [`pali`] library crate.

use std::{path::PathBuf, sync::Arc};

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use tracing::Instrument;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use pali::embedding::{CandleEmbeddingEngine, EmbeddingBackend, MODEL_ID};
use pali::health::HealthRegistry;
use pali::index::{UsearchStore, VectorStore};
use pali::recall_log::RecallLog;
use pali::repo::MemoryRepo;
use pali::server::MemoryServer;
use pali::state::AppState;
use pali::types::validate_branch_name;

#[derive(Parser)]
#[command(
    name = "pali",
    about = "Semantic memory MCP server for AI agents",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the MCP server (default)
    Serve(ServeArgs),
    /// Verify the embedding model loads and prime the OS page cache (useful
    /// as a container init step, after fetching the model with
    /// `scripts/fetch-model.sh`)
    Warmup(WarmupArgs),
    /// Show recall precision statistics by distance bucket
    RecallStats(RecallStatsArgs),
    /// Bootstrap a workspace: scan text files, report potential secrets, and
    /// write the git-aware manifest and insights when it is a repository
    Scan(ScanArgs),
    /// Bootstrap a workspace: embed scanned files into a local vector index
    Index(IndexArgs),
    /// Bootstrap a workspace: write scanned chunks as a JSONL dataset
    Dataset(DatasetArgs),
}

#[derive(Args)]
struct ServeArgs {
    /// Path to the git-backed memory repository.
    #[arg(long, default_value = "~/.memory-mcp", env = "PALI_REPO_PATH")]
    repo_path: String,

    /// Path to the TOML config file for per-scope remote mapping.
    /// Defaults to `memory-mcp/config.toml` under the platform config
    /// directory. Set to an empty string to disable config loading.
    #[arg(long, env = "PALI_CONFIG")]
    config: Option<String>,

    /// Remote URL for the git origin. If set, the origin remote is created or
    /// updated on startup. Omit to run in local-only mode (no push/pull).
    #[arg(long, env = "PALI_REMOTE_URL")]
    remote_url: Option<String>,

    /// Branch name used for push/pull operations.
    #[arg(long, default_value = "main", env = "PALI_BRANCH")]
    branch: String,

    /// Pull every repository before startup index freshness is decided, and
    /// refuse to start when no `--remote-url` is configured.
    #[arg(long, default_value_t = false, env = "PALI_REQUIRE_REMOTE_SYNC")]
    require_remote_sync: bool,

    /// SQLite busy timeout in seconds for the recall event log.
    ///
    /// When multiple processes access the recall log concurrently, this
    /// controls how long each connection waits for a database lock before
    /// returning an error.
    #[arg(long, default_value_t = 5, env = "PALI_RECALL_LOG_BUSY_TIMEOUT")]
    recall_log_busy_timeout: u64,

    #[command(flatten)]
    embed: EmbedArgs,
}

#[derive(Args)]
struct WarmupArgs {
    #[command(flatten)]
    embed: EmbedArgs,
}

#[derive(Args)]
struct RecallStatsArgs {
    /// Path to the recall log database.
    #[arg(long, env = "PALI_RECALL_LOG")]
    recall_log: Option<String>,

    /// Path to the index directory (default: ~/.memory-mcp/.memory-mcp-index).
    #[arg(long)]
    index_dir: Option<String>,
}

#[derive(Args)]
struct ScanArgs {
    #[command(flatten)]
    workspace: WorkspaceArgs,

    /// Record per-line commit IDs from git blame. Only commit IDs and line
    /// numbers are written — never author names, emails, or source lines.
    #[arg(long, default_value_t = false)]
    blame: bool,

    /// Maximum size in bytes of an included file.
    #[arg(long, default_value_t = 2 * 1024 * 1024, value_parser = parse_nonzero_u64)]
    max_file_bytes: u64,

    /// Save the insight digest as one memory in a pali memory repository.
    #[arg(long, default_value_t = false)]
    save_memories: bool,

    /// Memory repository for --save-memories. Created when it does not exist.
    #[arg(long, default_value = "~/.memory-mcp")]
    repo_path: String,

    /// Memory scope for --save-memories. Defaults to the workspace directory
    /// name.
    #[arg(long)]
    scope: Option<String>,
}

#[derive(Args)]
struct IndexArgs {
    #[command(flatten)]
    workspace: WorkspaceArgs,

    #[command(flatten)]
    embed: EmbedArgs,
}

#[derive(Args)]
struct DatasetArgs {
    #[command(flatten)]
    workspace: WorkspaceArgs,

    /// Dataset output path. Relative paths resolve against the workspace root;
    /// the default is `<artifacts>/dataset.jsonl`.
    #[arg(long)]
    output: Option<PathBuf>,
}

#[derive(Args)]
struct WorkspaceArgs {
    /// Workspace directory to bootstrap.
    #[arg(long, default_value = ".")]
    workspace: PathBuf,

    /// Bound the number of files scanned, for a sample run.
    #[arg(long, value_parser = parse_nonzero_usize)]
    limit: Option<usize>,

    /// Directory for scan, index, and dataset artifacts. Relative paths
    /// resolve against the workspace root; the default is `<workspace>/.pali`.
    #[arg(long)]
    artifacts: Option<PathBuf>,
}

#[derive(Args)]
struct EmbedArgs {
    /// Maximum seconds a single embedding call may block. After a timeout the
    /// caller receives an error but the worker recovers automatically.
    #[arg(
        long,
        default_value_t = 30,
        env = "PALI_EMBED_TIMEOUT_SECS",
        value_parser = parse_nonzero_u64
    )]
    embed_timeout_secs: u64,

    /// Maximum number of embedding requests that can queue behind the worker.
    /// Higher values allow more concurrent callers to wait; lower values fail
    /// fast under load.
    #[arg(
        long,
        default_value_t = 64,
        env = "PALI_EMBED_QUEUE_SIZE",
        value_parser = parse_nonzero_usize
    )]
    embed_queue_size: usize,
}

/// Initialise the global tracing subscriber: Registry + EnvFilter
/// (`pali=info` default) + fmt writing to stderr.
fn init_tracing() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "pali=info,warn".to_string().into()),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Tracing goes to stderr only — stdout must remain clean for MCP.
    init_tracing();

    reject_legacy_environment()?;
    let cli = Cli::parse();

    match cli.command {
        None => {
            // Re-parse as "pali serve" so clap's env var resolution runs.
            let cli = Cli::parse_from(["pali", "serve"]);
            match cli.command {
                Some(Command::Serve(args)) => {
                    run_serve(args).await?;
                }
                _ => unreachable!(),
            }
        }
        Some(Command::Serve(args)) => {
            run_serve(args).await?;
        }
        Some(Command::Warmup(args)) => {
            run_warmup(args).await?;
        }
        Some(Command::RecallStats(args)) => {
            run_recall_stats(args)?;
        }
        Some(Command::Scan(args)) => {
            run_scan(args).await?;
        }
        Some(Command::Index(args)) => {
            run_index(args).await?;
        }
        Some(Command::Dataset(args)) => {
            run_dataset(args)?;
        }
    }

    Ok(())
}

/// Refuse a partial 0.19 configuration migration instead of silently using
/// defaults for legacy environment variables. Values are never inspected or
/// included in the error because the set can contain credentials.
fn reject_legacy_environment() -> anyhow::Result<()> {
    let mut replacements = Vec::new();
    let mut unknown_count = 0usize;
    for (name, _) in std::env::vars_os() {
        match legacy_environment_replacement(&name) {
            Some(Some(replacement)) => replacements.push(replacement),
            Some(None) => {
                unknown_count += 1;
            }
            None => {}
        }
    }
    replacements.sort();
    replacements.dedup();

    if replacements.is_empty() && unknown_count == 0 {
        return Ok(());
    }

    let known = if replacements.is_empty() {
        String::new()
    } else {
        format!(": {}", replacements.join(", "))
    };
    let unknown = if unknown_count == 0 {
        String::new()
    } else {
        format!("; {unknown_count} unknown legacy-prefixed variable(s) also set")
    };
    anyhow::bail!(
        "legacy Pali environment variable(s) are not supported{known}{unknown}; update or remove them before starting Pali"
    )
}

#[cfg(unix)]
fn legacy_environment_replacement(name: &std::ffi::OsStr) -> Option<Option<String>> {
    use std::os::unix::ffi::OsStrExt as _;

    const LEGACY_PREFIX: &[u8] = b"MEMORY_MCP_";

    let bytes = name.as_bytes();
    let prefix = bytes.get(..LEGACY_PREFIX.len())?;
    if !prefix.eq_ignore_ascii_case(LEGACY_PREFIX) {
        return None;
    }
    let suffix = &bytes[LEGACY_PREFIX.len()..];
    legacy_suffix_replacement(suffix)
}

#[cfg(windows)]
fn legacy_environment_replacement(name: &std::ffi::OsStr) -> Option<Option<String>> {
    use std::os::windows::ffi::OsStrExt as _;

    const LEGACY_PREFIX: &[u8] = b"MEMORY_MCP_";

    let units: Vec<u16> = name.encode_wide().collect();
    let prefix = units.get(..LEGACY_PREFIX.len())?;
    if !prefix.iter().zip(LEGACY_PREFIX).all(|(unit, expected)| {
        u8::try_from(*unit).is_ok_and(|byte| byte.eq_ignore_ascii_case(expected))
    }) {
        return None;
    }
    let suffix: Option<Vec<u8>> = units[LEGACY_PREFIX.len()..]
        .iter()
        .map(|unit| u8::try_from(*unit).ok())
        .collect();
    match suffix {
        Some(suffix) => legacy_suffix_replacement(&suffix),
        None => Some(None),
    }
}

#[cfg(all(not(unix), not(windows)))]
fn legacy_environment_replacement(name: &std::ffi::OsStr) -> Option<Option<String>> {
    let canonical_name = name.to_str()?.to_ascii_uppercase();
    let suffix = canonical_name.strip_prefix("MEMORY_MCP_")?;
    legacy_suffix_replacement(suffix.as_bytes())
}

fn legacy_suffix_replacement(suffix: &[u8]) -> Option<Option<String>> {
    const LEGACY_SUFFIXES: &[&str] = &[
        "BRANCH",
        "CONFIG",
        "EMBED_QUEUE_SIZE",
        "EMBED_TIMEOUT_SECS",
        "RECALL_LOG",
        "RECALL_LOG_BUSY_TIMEOUT",
        "REMOTE_URL",
        "REPO_PATH",
        "REQUIRE_REMOTE_SYNC",
    ];

    let Some(canonical) = LEGACY_SUFFIXES
        .iter()
        .find(|candidate| suffix.eq_ignore_ascii_case(candidate.as_bytes()))
    else {
        return Some(None);
    };
    Some(Some(format!("MEMORY_MCP_{canonical} -> PALI_{canonical}")))
}

/// Start and run the MCP server with the provided arguments.
async fn run_serve(args: ServeArgs) -> anyhow::Result<()> {
    // Validate branch name early to prevent ref injection.
    validate_branch_name(&args.branch).context("invalid --branch value")?;

    // Expand `~` in repo_path, failing loudly if HOME is not set and the
    // path requires it (i.e. the user did not provide --repo-path explicitly).
    // Canonicalize BEFORE opening so the location the repo is opened at and
    // the router's collision-detection key can never diverge (#293 review,
    // round 5: a symlink-plus-`..` spelling otherwise opens one physical
    // repo while collision detection records another).
    let repo_path = expand_path(&args.repo_path)?;
    let repo_path = pali::fs_util::canonicalize_allow_missing(&repo_path)
        .context("failed to canonicalize repo path")?;
    info!("repo path: {}", repo_path.display());

    // Filter out empty string to treat PALI_REMOTE_URL="" as unset.
    let remote_url = args.remote_url.filter(|u| !u.is_empty());

    if args.require_remote_sync && remote_url.is_none() {
        anyhow::bail!("--require-remote-sync requires --remote-url to be set");
    }

    // Create the health registry early so reporters can be passed to subsystems.
    let health = HealthRegistry::new();

    // Initialise subsystems — each called function creates its own span.
    let repo = MemoryRepo::init_or_open_with_reporter(
        &repo_path,
        remote_url.as_deref(),
        health.git.clone(),
        health.sync.clone(),
    )
    .with_context(|| format!("failed to open/init repo at {}", repo_path.display()))?;

    let embed_timeout = std::time::Duration::from_secs(args.embed.embed_timeout_secs);
    let embedding: Box<dyn EmbeddingBackend> = Box::new(
        CandleEmbeddingEngine::new(
            embed_timeout,
            args.embed.embed_queue_size,
            health.embedding.clone(),
        )
        .context("failed to init embedding engine")?,
    );

    let dimensions = embedding.dimensions();

    let index_dir = repo_path.join(".memory-mcp-index");

    // Remove legacy single-index files if they still exist from an old install.
    let old_index = index_dir.join("index.usearch");
    if old_index.exists() {
        if let Err(e) = tokio::fs::remove_file(&old_index).await {
            tracing::warn!(error = %e, "failed to remove legacy index file");
        }
        let keys_file = index_dir.join("index.usearch.keys.json");
        if let Err(e) = tokio::fs::remove_file(&keys_file).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(error = %e, "failed to remove legacy index keys file");
        }
        info!("removed legacy single-index files");
    }

    let repo = Arc::new(repo);

    let router = {
        let config_path = match &args.config {
            Some(p) if p.is_empty() => None,
            Some(p) => Some(expand_path(p)?),
            None => pali::config::Config::resolve_path().ok(),
        };

        if let Some(ref path) = config_path {
            let config = pali::config::Config::load(path)
                .with_context(|| format!("failed to load config from {}", path.display()))?;
            if config.remotes.is_empty() {
                pali::repo_router::RepoRouter::single(Arc::clone(&repo))
            } else {
                pali::repo_router::RepoRouter::from_config(
                    Arc::clone(&repo),
                    &config.remotes,
                    &health.git,
                    &health.sync,
                )
                .context("failed to initialise scope-specific repos from config")?
            }
        } else {
            pali::repo_router::RepoRouter::single(Arc::clone(&repo))
        }
    };

    // Load the persisted index; create fresh if missing or corrupt. Freshness
    // against repo HEAD is decided inside `startup_prepare_index`, after the
    // initial pull.
    let loaded_index: Box<dyn VectorStore> = Box::new(
        UsearchStore::load_with_reporter(&index_dir, dimensions, health.vector_index.clone())
            .unwrap_or_else(|e| {
                tracing::warn!("could not load index ({}), creating fresh", e);
                UsearchStore::new_with_reporter(dimensions, health.vector_index.clone())
                    .expect("failed to create index")
            }),
    );

    // When --require-remote-sync is set, the initial pull runs BEFORE the
    // index freshness check (#327): on a fresh repo path the pull is what
    // populates the repo, so the startup reindex must run against post-pull
    // git truth — otherwise the server reports ready while semantic recall
    // misses every pulled memory. The pull covers every routed repo (default
    // + scope-mapped remotes, with branch overrides — #328 review, round 2)
    // and seeds aggregate sync health with a known state.
    let initial_pull =
        (args.require_remote_sync && remote_url.is_some()).then_some(args.branch.as_str());

    let vector_reporter = health.vector_index.clone();
    let (index, reindex_ok) = pali::server::startup_prepare_index(
        initial_pull,
        &router,
        embedding.as_ref(),
        loaded_index,
        move || {
            Box::new(
                UsearchStore::new_with_reporter(dimensions, vector_reporter)
                    .expect("failed to create index"),
            )
        },
    )
    .await;

    // Tracks whether the vector index verifiably mirrors git truth at startup.
    // A reindex that did not complete cleanly is a gap only the next full
    // reindex closes, so SHA advancement must stay blocked for this process.
    let startup_mirror_gap = !reindex_ok;

    // Only mark subsystems healthy if the reindex succeeded or was skipped
    // (SHA matched). If the reindex had errors, the subsystems have already
    // reported their own state via their reporters — an unconditional
    // `health.git.report_ok()` here erased a strict-list/reindex repo
    // failure recorded during the rebuild (#293 review, round 4). Git
    // init/open succeeding earlier is not evidence that every repo listed
    // cleanly.
    if reindex_ok {
        health.git.report_ok();
        health.embedding.report_ok();
        health.vector_index.report_ok();
    }

    let recall_log_path = index_dir.join("recall_log.sqlite");
    let recall_log = match RecallLog::open(
        &recall_log_path,
        std::time::Duration::from_secs(args.recall_log_busy_timeout),
    ) {
        Ok(log) => {
            info!("recall log opened at {}", recall_log_path.display());
            Some(Arc::new(log))
        }
        Err(e) => {
            warn!(error = %e, "failed to open recall log — recall events will not be logged");
            None
        }
    };

    let state = Arc::new(AppState::with_router(
        repo,
        router,
        args.branch.clone(),
        embedding,
        index,
        health,
        recall_log,
    ));
    if startup_mirror_gap {
        state.mark_index_mirror_incomplete();
    }

    // Populate the lexical (BM25) index. It lives in RAM only — indexing
    // text is cheap, unlike embedding it — so it is rebuilt from the repo on
    // every startup and never persisted or migrated. Failure degrades recall
    // to semantic-only; it never blocks startup.
    match pali::search::rebuild_lexical_from_router(&state.router, &state.lexical)
        .instrument(tracing::info_span!("startup.lexical_rebuild"))
        .await
    {
        Ok(count) => info!(count, "lexical index built"),
        Err(e) => {
            // Every startup-rebuild failure (including a repository-listing
            // failure before the rebuild seam) marks the index degraded, so
            // repair is scheduled here and re-triggered by recall until it
            // converges — the failure can never silently disable keyword
            // search for the process lifetime.
            tracing::warn!(
                error = %e,
                degraded = state.lexical.is_degraded(),
                "lexical index startup rebuild failed — keyword search \
                 degraded until background repair converges"
            );
            pali::search::spawn_lexical_repair_for_router(&state.router, &state.lexical);
        }
    }

    // Keep a reference for post-shutdown index persistence.
    let state_for_shutdown = Arc::clone(&state);

    serve_stdio(Arc::clone(&state_for_shutdown)).await?;

    // Persist the scoped vector index so the next startup can skip a full
    // reindex. The stored SHA only advances when the in-process mirror is
    // intact — a recorded mirror gap keeps the last verified SHA so the next
    // startup rebuilds from git truth.
    if let Err(e) = pali::server::persist_index_on_shutdown(&state_for_shutdown, &index_dir).await {
        tracing::warn!("failed to persist vector index on shutdown: {}", e);
    } else {
        info!("vector index saved to {}", index_dir.display());
    }

    Ok(())
}

/// Serve MCP over stdio until the client closes its end of the pipe.
///
/// The process is the session: there is exactly one connection, stdout is
/// reserved for MCP frames, and diagnostics stay on stderr. Startup — repo,
/// embeddings, indexes — runs before this, so the only shutdown source is the
/// client closing its end of the pipe.
async fn serve_stdio(state: Arc<AppState>) -> anyhow::Result<()> {
    use rmcp::ServiceExt as _;

    let server = MemoryServer::new(state);
    info!("serving MCP over stdio");
    let running = server
        .serve(rmcp::transport::io::stdio())
        .await
        .context("failed to start MCP stdio transport")?;
    running
        .waiting()
        .await
        .context("MCP stdio transport ended with an error")?;
    Ok(())
}

/// Build workspace options from the shared workspace flags.
fn workspace_options(args: &WorkspaceArgs) -> anyhow::Result<pali::workspace::ScanOptions> {
    let mut options = pali::workspace::ScanOptions::new(args.workspace.clone())?;
    if let Some(limit) = args.limit {
        options = options.with_limit(limit);
    }
    if let Some(artifacts) = &args.artifacts {
        options = options.with_artifacts(artifacts);
    }
    Ok(options)
}

/// Scan the workspace and print its summary.
///
/// The workspace's own git repository drives the scan when there is one: that
/// pass writes the security report, the manifest, and the codebase insights.
/// A plain directory still gets the file and secret report from the workspace
/// scanner. `--save-memories` commits the insight digest, so it needs a
/// repository.
async fn run_scan(args: ScanArgs) -> anyhow::Result<()> {
    let mut options = pali::scanner::RepositoryScanOptions::new(args.workspace.workspace.clone())?
        .with_max_file_bytes(args.max_file_bytes)
        .with_blame(args.blame);
    if let Some(limit) = args.workspace.limit {
        options = options.with_limit(limit);
    }
    if let Some(artifacts) = &args.workspace.artifacts {
        options = options.with_artifacts(artifacts);
    }

    let summary = match pali::scanner::scan_repositories(&options) {
        Ok(summary) => summary,
        Err(pali::error::MemoryError::InvalidInput { .. }) if !args.save_memories => {
            // Not a git repository: fall back to the plain workspace scan.
            let plain = pali::workspace::scan(&workspace_options(&args.workspace)?)?;
            println!("{}", serde_json::to_string_pretty(&plain)?);
            return Ok(());
        }
        Err(pali::error::MemoryError::InvalidInput { .. }) => {
            anyhow::bail!(
                "--save-memories needs a git repository; {} is not one",
                options.root().display()
            );
        }
        Err(error) => return Err(error.into()),
    };

    if args.save_memories {
        let repo_path = expand_path(&args.repo_path)?;
        let repo_path = pali::fs_util::canonicalize_allow_missing(&repo_path)?;
        let scope = args
            .scope
            .unwrap_or_else(|| pali::scanner::default_scope(options.root()));
        pali::scanner::save_insights(&repo_path, &scope, &summary.insights_markdown)
            .await
            .with_context(|| {
                format!(
                    "failed to save codebase insights to {}",
                    repo_path.display()
                )
            })?;
        tracing::info!(
            scope,
            memory = pali::scanner::INSIGHTS_MEMORY_NAME,
            "saved codebase insights"
        );
    }

    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

/// Embed a workspace into `<artifacts>/index` and print its summary.
async fn run_index(args: IndexArgs) -> anyhow::Result<()> {
    use pali::health::SubsystemReporter;

    let options = workspace_options(&args.workspace)?;
    let embedding = CandleEmbeddingEngine::new(
        std::time::Duration::from_secs(args.embed.embed_timeout_secs),
        args.embed.embed_queue_size,
        SubsystemReporter::new(),
    )
    .context("failed to init embedding engine")?;
    let summary = pali::workspace::index(&options, &embedding).await?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

/// Write a workspace chunk dataset and print its summary.
fn run_dataset(args: DatasetArgs) -> anyhow::Result<()> {
    let summary =
        pali::workspace::dataset(&workspace_options(&args.workspace)?, args.output.as_deref())?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

/// Print recall precision statistics bucketed by distance range.
fn run_recall_stats(args: RecallStatsArgs) -> anyhow::Result<()> {
    // Resolve the recall log path: explicit flag > env var (handled by clap) >
    // default derived from index_dir or ~/.memory-mcp/.memory-mcp-index.
    let log_path = if let Some(p) = args.recall_log {
        PathBuf::from(p)
    } else {
        let index_dir = if let Some(d) = args.index_dir {
            PathBuf::from(d)
        } else {
            let home = dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("could not determine home directory"))?;
            home.join(".memory-mcp").join(".memory-mcp-index")
        };
        index_dir.join("recall_log.sqlite")
    };

    let log = RecallLog::open(&log_path, std::time::Duration::from_secs(5))
        .with_context(|| format!("failed to open recall log at {}", log_path.display()))?;

    let buckets = log
        .recall_stats()
        .context("failed to compute recall stats")?;

    let any = buckets.iter().any(|b| b.total > 0);
    if !any {
        println!("No recall events recorded yet.");
        return Ok(());
    }

    for b in &buckets {
        if b.total == 0 {
            continue;
        }
        let applied_pct = if b.applied > 0 {
            format!("{}%", (b.applied * 100) / b.total)
        } else {
            "0%".to_string()
        };
        println!(
            "{:.2}–{:.2}:  applied {} ({}/{}), maybe {}, not_applied {}, unknown {}",
            b.range_start,
            b.range_end,
            applied_pct,
            b.applied,
            b.total,
            b.maybe,
            b.not_applied,
            b.unknown
        );
    }

    Ok(())
}

/// Load the embedding model and run a single dummy embed to verify the model
/// files are present and valid, and to prime the OS page cache for the
/// memory-mapped weights file. Fails if the model has not been provisioned
/// with `scripts/fetch-model.sh` (or an equivalent manual download — Pali
/// does not fetch the model itself). Intended as a container init step or a
/// pre-flight check in CI.
async fn run_warmup(args: WarmupArgs) -> anyhow::Result<()> {
    use pali::health::SubsystemReporter;
    info!("warming up embedding model '{}'", MODEL_ID);
    let engine = CandleEmbeddingEngine::new(
        std::time::Duration::from_secs(args.embed.embed_timeout_secs),
        args.embed.embed_queue_size,
        SubsystemReporter::new(),
    )
    .context("failed to init embedding engine")?;
    // Run one dummy embed to force the first inference pass (lazy
    // initialisation inside candle) and touch every page of the
    // memory-mapped weights file, so the OS page cache is warm before the
    // real server starts.
    let _ = engine
        .embed(&["warmup".to_string()])
        .await
        .context("warmup embed failed")?;
    info!("warmup complete");
    Ok(())
}

/// Parse a `usize` that must be at least 1. Used as a clap `value_parser`.
fn parse_nonzero_usize(s: &str) -> Result<usize, String> {
    let n: usize = s
        .parse()
        .map_err(|_| format!("'{s}' is not a valid integer"))?;
    if n == 0 {
        return Err("value must be at least 1".to_owned());
    }
    Ok(n)
}

/// Parse a `u64` that must be at least 1. Used as a clap `value_parser`.
fn parse_nonzero_u64(s: &str) -> Result<u64, String> {
    let n: u64 = s
        .parse()
        .map_err(|_| format!("'{s}' is not a valid integer"))?;
    if n == 0 {
        return Err("value must be at least 1".to_owned());
    }
    Ok(n)
}

fn expand_path(path: &str) -> anyhow::Result<PathBuf> {
    pali::fs_util::expand_tilde(path).map_err(|e| anyhow::anyhow!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, Parser};

    #[test]
    fn runtime_cli_environment_uses_only_pali_prefix() {
        let command = Cli::command();
        let mut environment_variables: Vec<String> = command
            .get_subcommands()
            .flat_map(|subcommand| subcommand.get_arguments())
            .filter_map(|argument| argument.get_env())
            .map(|name| name.to_string_lossy().into_owned())
            .collect();
        environment_variables.sort();
        environment_variables.dedup();

        let mut expected = vec![
            "PALI_BRANCH",
            "PALI_CONFIG",
            "PALI_EMBED_QUEUE_SIZE",
            "PALI_EMBED_TIMEOUT_SECS",
            "PALI_RECALL_LOG",
            "PALI_RECALL_LOG_BUSY_TIMEOUT",
            "PALI_REMOTE_URL",
            "PALI_REPO_PATH",
            "PALI_REQUIRE_REMOTE_SYNC",
        ];
        expected.sort_unstable();

        assert_eq!(environment_variables, expected);
    }

    #[test]
    fn legacy_environment_mapping_is_ascii_case_insensitive() {
        let mappings = [
            ("BRANCH", "MEMORY_MCP_BRANCH -> PALI_BRANCH"),
            ("CONFIG", "MEMORY_MCP_CONFIG -> PALI_CONFIG"),
            (
                "EMBED_QUEUE_SIZE",
                "MEMORY_MCP_EMBED_QUEUE_SIZE -> PALI_EMBED_QUEUE_SIZE",
            ),
            (
                "EMBED_TIMEOUT_SECS",
                "MEMORY_MCP_EMBED_TIMEOUT_SECS -> PALI_EMBED_TIMEOUT_SECS",
            ),
            ("RECALL_LOG", "MEMORY_MCP_RECALL_LOG -> PALI_RECALL_LOG"),
            (
                "RECALL_LOG_BUSY_TIMEOUT",
                "MEMORY_MCP_RECALL_LOG_BUSY_TIMEOUT -> PALI_RECALL_LOG_BUSY_TIMEOUT",
            ),
            ("REMOTE_URL", "MEMORY_MCP_REMOTE_URL -> PALI_REMOTE_URL"),
            ("REPO_PATH", "MEMORY_MCP_REPO_PATH -> PALI_REPO_PATH"),
            (
                "REQUIRE_REMOTE_SYNC",
                "MEMORY_MCP_REQUIRE_REMOTE_SYNC -> PALI_REQUIRE_REMOTE_SYNC",
            ),
        ];

        assert_eq!(mappings.len(), 9);
        for (suffix, expected) in mappings {
            let lowercase_name = format!("memory_mcp_{}", suffix.to_ascii_lowercase());
            assert_eq!(
                legacy_environment_replacement(std::ffi::OsStr::new(&lowercase_name))
                    .flatten()
                    .as_deref(),
                Some(expected),
                "missing or incorrect mapping for {suffix}"
            );
        }
        assert!(legacy_environment_replacement(std::ffi::OsStr::new("UNRELATED_BIND")).is_none());
        assert_eq!(
            legacy_environment_replacement(std::ffi::OsStr::new("MEMORY_MCP_UNKNOWN")),
            Some(None)
        );
    }

    #[cfg(windows)]
    #[test]
    fn legacy_environment_mapping_rejects_ill_formed_utf16_suffix() {
        use std::os::windows::ffi::OsStringExt as _;

        let mut units: Vec<u16> = "MEMORY_MCP_".encode_utf16().collect();
        units.push(0xd800);
        let name = std::ffi::OsString::from_wide(&units);
        assert_eq!(
            legacy_environment_replacement(&name),
            Some(None),
            "an ill-formed suffix must still be classified as legacy"
        );
    }

    #[test]
    fn test_cli_bare_has_no_command() {
        let cli = Cli::try_parse_from(["pali"]).expect("bare invocation should parse");
        assert!(cli.command.is_none());
    }

    #[test]
    fn test_bare_serve_reparsed_uses_env_var() {
        let cli = Cli::parse_from(["pali", "serve"]);
        assert!(matches!(cli.command, Some(Command::Serve(_))));
    }

    #[test]
    fn test_parse_nonzero_usize_zero_is_err() {
        assert!(parse_nonzero_usize("0").is_err());
    }

    #[test]
    fn test_parse_nonzero_usize_non_numeric_is_err() {
        assert!(parse_nonzero_usize("abc").is_err());
    }

    #[test]
    fn test_parse_nonzero_usize_one_is_ok() {
        assert_eq!(parse_nonzero_usize("1").unwrap(), 1);
    }

    #[test]
    fn test_parse_nonzero_u64_zero_is_err() {
        assert!(parse_nonzero_u64("0").is_err());
    }

    #[test]
    fn test_parse_nonzero_u64_non_numeric_is_err() {
        assert!(parse_nonzero_u64("abc").is_err());
    }

    #[test]
    fn test_parse_nonzero_u64_one_is_ok() {
        assert_eq!(parse_nonzero_u64("1").unwrap(), 1);
    }

    #[test]
    fn test_cli_version() {
        match Cli::try_parse_from(["pali", "--version"]) {
            Err(e) => assert_eq!(e.kind(), clap::error::ErrorKind::DisplayVersion),
            Ok(_) => panic!("--version should cause clap to exit"),
        }
    }

    #[test]
    fn test_expand_path_tilde_alone() {
        let result = expand_path("~").unwrap();
        assert_eq!(result, dirs::home_dir().unwrap());
    }

    #[test]
    fn test_expand_path_tilde_slash() {
        let result = expand_path("~/foo/bar").unwrap();
        assert_eq!(result, dirs::home_dir().unwrap().join("foo/bar"));
    }

    #[test]
    fn test_expand_path_absolute() {
        let result = expand_path("/tmp/repo").unwrap();
        assert_eq!(result, PathBuf::from("/tmp/repo"));
    }

    #[test]
    fn test_expand_path_relative() {
        let result = expand_path("relative/path").unwrap();
        assert_eq!(result, PathBuf::from("relative/path"));
    }

    #[test]
    fn test_expand_path_tilde_user_rejected() {
        let result = expand_path("~otheruser/path");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("not supported"),
            "error should mention unsupported: {msg}"
        );
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;
    use clap::Parser;

    fn scan_args(extra: &[&str]) -> ScanArgs {
        let mut argv = vec!["pali", "scan"];
        argv.extend_from_slice(extra);
        match Cli::try_parse_from(argv).expect("scan must parse").command {
            Some(Command::Scan(args)) => args,
            _ => panic!("expected the scan subcommand"),
        }
    }

    #[test]
    fn scan_defaults_keep_the_plain_workspace_scan() {
        let args = scan_args(&[]);
        assert!(!args.blame);
        assert!(!args.save_memories);
        assert_eq!(args.max_file_bytes, 2 * 1024 * 1024);
        assert_eq!(args.repo_path, "~/.memory-mcp");
        assert!(args.scope.is_none());
        assert_eq!(args.workspace.workspace, PathBuf::from("."));
    }

    #[test]
    fn scan_carries_the_repository_flags_it_folded_in() {
        let args = scan_args(&[
            "--workspace",
            "/w",
            "--blame",
            "--max-file-bytes",
            "1048576",
            "--save-memories",
            "--repo-path",
            "/mem",
            "--scope",
            "team",
            "--limit",
            "5",
        ]);
        assert!(args.blame);
        assert!(args.save_memories);
        assert_eq!(args.max_file_bytes, 1_048_576);
        assert_eq!(args.repo_path, "/mem");
        assert_eq!(args.scope.as_deref(), Some("team"));
        assert_eq!(args.workspace.limit, Some(5));
        assert_eq!(args.workspace.workspace, PathBuf::from("/w"));
    }

    #[test]
    fn scan_rejects_a_zero_file_size_bound() {
        let error = match Cli::try_parse_from(["pali", "scan", "--max-file-bytes", "0"]) {
            Ok(_) => panic!("a zero bound must be rejected"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("max-file-bytes"), "{error}");
    }

    #[test]
    fn the_scan_repos_subcommand_is_gone() {
        // Regression: scan-repos was folded into scan. Leaving the variant
        // alive would let a caller keep the old two-command split.
        assert!(Cli::try_parse_from(["pali", "scan-repos"]).is_err());
    }
}
