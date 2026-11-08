//! Shared application state threaded through the MCP tool handlers, plus the
//! reindex statistics DTO.

use std::sync::Arc;

use crate::{
    embedding::EmbeddingBackend, health::HealthRegistry, index::VectorStore, recall_log::RecallLog,
    repo::MemoryRepo, repo_router::RepoRouter, search::LexicalIndex,
};

/// Statistics from an incremental reindex operation.
#[derive(Debug, Default)]
pub struct ReindexStats {
    /// Number of newly indexed memories.
    pub added: usize,
    /// Number of memories whose embeddings were refreshed.
    pub updated: usize,
    /// Number of memories removed from the index.
    pub removed: usize,
    /// Number of memories that failed to index.
    pub errors: usize,
}

/// Shared application state threaded through the MCP tool handlers.
///
/// Wrapped in a single outer `Arc` at the call site. `repo` is additionally
/// wrapped in its own `Arc` so it can be cloned into `spawn_blocking` closures.
#[non_exhaustive]
pub struct AppState {
    /// Git-backed memory repository (default repo, for backward compat).
    pub repo: Arc<MemoryRepo>,
    /// Routes memory operations to scope-specific repos when configured.
    pub router: RepoRouter,
    /// Backend used to compute text embeddings.
    pub embedding: Box<dyn EmbeddingBackend>,
    /// In-memory vector index for semantic search (scope-partitioned).
    pub index: Box<dyn VectorStore>,
    /// In-RAM BM25 index for keyword search (rebuilt from the repo on startup).
    pub lexical: Arc<LexicalIndex>,
    /// Branch name used for push/pull operations (default: "main").
    pub branch: String,
    /// Passive health registry — subsystems report their operational state here.
    pub health: HealthRegistry,
    /// Optional append-only recall event log for threshold calibration.
    pub recall_log: Option<Arc<RecallLog>>,
    /// `true` while every git HEAD advance since the vector index's stored
    /// commit SHA has been fully mirrored into the vector index.
    ///
    /// Cleared — sticky for the process lifetime — when a mirror gap opens
    /// that only a full reindex can close: post-pull change discovery fails,
    /// pulled files cannot be resolved, an incremental reindex records any
    /// item-level error, or the startup reindex did not complete cleanly
    /// (#293 review, round 3: partial success is not certification). While
    /// cleared, composite-SHA advancement is refused at both sync and
    /// shutdown, so the next startup detects the SHA mismatch and rebuilds
    /// the vector index from git truth.
    index_mirror_intact: std::sync::atomic::AtomicBool,
}

impl AppState {
    /// Create a new application state from subsystem instances.
    pub fn new(
        repo: Arc<MemoryRepo>,
        branch: String,
        embedding: Box<dyn EmbeddingBackend>,
        index: Box<dyn VectorStore>,
        health: HealthRegistry,
        recall_log: Option<Arc<RecallLog>>,
    ) -> Self {
        let router = RepoRouter::single(Arc::clone(&repo));
        Self {
            repo,
            router,
            embedding,
            index,
            lexical: Arc::new(LexicalIndex::new()),
            branch,
            health,
            recall_log,
            index_mirror_intact: std::sync::atomic::AtomicBool::new(true),
        }
    }

    /// Create a new application state with a pre-built repo router.
    #[allow(clippy::too_many_arguments)]
    pub fn with_router(
        repo: Arc<MemoryRepo>,
        router: RepoRouter,
        branch: String,
        embedding: Box<dyn EmbeddingBackend>,
        index: Box<dyn VectorStore>,
        health: HealthRegistry,
        recall_log: Option<Arc<RecallLog>>,
    ) -> Self {
        Self {
            repo,
            router,
            embedding,
            index,
            // Constructed here rather than injected: creation is infallible
            // (a failure yields a disabled instance) and the index starts
            // empty either way — callers populate it via
            // `search::rebuild_lexical_from_repo` or the write handlers.
            lexical: Arc::new(LexicalIndex::new()),
            branch,
            health,
            recall_log,
            index_mirror_intact: std::sync::atomic::AtomicBool::new(true),
        }
    }

    /// Record that the vector index has a mirror gap only a full reindex can
    /// close, blocking composite-SHA advancement for the rest of the process
    /// lifetime (see [`AppState::index_mirror_is_intact`]).
    pub fn mark_index_mirror_incomplete(&self) {
        self.index_mirror_intact
            .store(false, std::sync::atomic::Ordering::Release);
    }

    /// `true` when the vector index mirror has no known gap and composite-SHA
    /// advancement is allowed.
    pub fn index_mirror_is_intact(&self) -> bool {
        self.index_mirror_intact
            .load(std::sync::atomic::Ordering::Acquire)
    }
}
