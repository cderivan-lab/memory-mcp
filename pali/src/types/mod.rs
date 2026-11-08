//! Domain types: memories, scopes, metadata, validation, and application state.

mod args;
mod chunk;
mod memory;
mod scope;
mod validated;

pub use args::{
    BatchMarkAppliedArgs, EditArgs, ForgetArgs, ListArgs, ListField, MarkAppliedArgs, MoveArgs,
    ReadArgs, RecallArgs, RecallStatsArgs, RememberArgs, SyncArgs, Verdict, VerdictEntry,
};

pub(crate) use args::{LIST_MAX_LIMIT, ListToolArgs, ListToolField, RecallToolArgs};
pub(crate) use scope::scope_path_matches;

pub use chunk::{ChunkerVersion, FactId, SourceSpan};

// The catalog and recall-wire shapes (`FactRecord`, `MatchedChunk`) are
// deliberately not re-exported: they stay internal to `chunk` until
// their owning slices (#262 slices 3 and 7) produce a consumer
// (ADR-0042) — every `pub` item is a semver commitment.

pub use memory::{Memory, MemoryMetadata, MemoryName, MemoryRef, parse_qualified_name};

pub use scope::{Scope, ScopeFilter, ScopePath, validate_branch_name};
