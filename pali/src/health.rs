//! Passive subsystem health recording.
//!
//! Subsystems report their own operational state via `SubsystemReporter`.
//! The registry keeps the latest snapshot per subsystem — reporting is
//! wait-free and performs no probing or I/O.

use std::sync::Arc;
use std::time::Instant;

use arc_swap::ArcSwap;

/// Per-subsystem health snapshot. Immutable once created.
pub struct SubsystemStatus {
    /// Whether the subsystem is currently healthy.
    pub healthy: bool,
    /// Human-readable reason for an unhealthy state. `None` when healthy.
    pub reason: Option<&'static str>,
    /// Timestamp of the most recent successful operation.
    pub last_success: Option<Instant>,
    /// Timestamp of the most recent failed operation.
    pub last_failure: Option<Instant>,
}

impl SubsystemStatus {
    fn initial() -> Self {
        Self {
            healthy: false,
            reason: Some("not yet checked"),
            last_success: None,
            last_failure: None,
        }
    }
}

/// Lightweight handle for a subsystem to report its health.
///
/// Clone is cheap (Arc clone). Each clone shares the same underlying state.
#[derive(Clone)]
pub struct SubsystemReporter {
    state: Arc<ArcSwap<SubsystemStatus>>,
}

impl SubsystemReporter {
    /// Create a new reporter. Initial state is "not yet checked" (unhealthy until first success).
    pub fn new() -> Self {
        Self {
            state: Arc::new(ArcSwap::new(Arc::new(SubsystemStatus::initial()))),
        }
    }

    /// Report a successful operation.
    pub fn report_ok(&self) {
        self.state.rcu(|current| {
            Arc::new(SubsystemStatus {
                healthy: true,
                reason: None,
                last_success: Some(Instant::now()),
                last_failure: current.last_failure,
            })
        });
    }

    /// Report a failed operation with a static reason string.
    pub fn report_err(&self, reason: &'static str) {
        self.state.rcu(|current| {
            Arc::new(SubsystemStatus {
                healthy: false,
                reason: Some(reason),
                last_success: current.last_success,
                last_failure: Some(Instant::now()),
            })
        });
    }

    /// Load the current status snapshot.
    pub fn load(&self) -> arc_swap::Guard<Arc<SubsystemStatus>> {
        self.state.load()
    }
}

impl Default for SubsystemReporter {
    fn default() -> Self {
        Self::new()
    }
}

/// Central registry holding reporters for all subsystems.
///
/// Lives on `AppState`; subsystems record their latest operational state here.
pub struct HealthRegistry {
    /// Reporter for the git-backed memory repository.
    pub git: SubsystemReporter,
    /// Reporter for the embedding engine.
    pub embedding: SubsystemReporter,
    /// Reporter for the vector index.
    pub vector_index: SubsystemReporter,
    /// Reporter for remote sync (push/pull) operations.
    pub sync: SubsystemReporter,
}

impl HealthRegistry {
    /// Create a new registry with all subsystems in "not yet checked" state.
    pub fn new() -> Self {
        Self {
            git: SubsystemReporter::new(),
            embedding: SubsystemReporter::new(),
            vector_index: SubsystemReporter::new(),
            sync: SubsystemReporter::new(),
        }
    }
}

impl Default for HealthRegistry {
    fn default() -> Self {
        Self::new()
    }
}
