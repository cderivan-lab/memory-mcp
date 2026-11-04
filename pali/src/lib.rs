//! Semantic memory engine with pure-Rust embeddings and git-backed storage.
//!
//! This crate provides the library core for `pali`, an MCP server that
//! stores and retrieves memories using vector similarity search. Embeddings
//! are computed on-device via candle (BERT inference) with no C/C++ FFI.

#![warn(missing_docs)]

/// Configuration file parsing for per-scope remote mapping.
pub mod config;
/// Embedding backends for computing vector representations of text.
pub mod embedding;
/// Error types used throughout the crate.
pub mod error;
/// Filesystem utilities — atomic writes, path helpers, crash-safe temp-file-then-rename.
pub mod fs_util;
mod git_read;
/// Passive subsystem health recording.
pub mod health;
/// HNSW vector index for approximate nearest-neighbour search.
pub mod index;
/// Append-only SQLite event log for recall telemetry and threshold calibration.
pub mod recall_log;
/// Git-backed memory repository — read, write, sync, and diff operations.
pub mod repo;
/// Routes memory operations to scope-specific git repositories.
pub mod repo_router;
/// Repository scanner — git-aware inventory, security report, and manifest.
pub mod scanner;
/// Hybrid retrieval — semantic + BM25 lexical search merged via rank fusion.
pub mod search;
/// MCP server implementation — tool handlers for the memory protocol.
pub mod server;
/// Test-only tracing capture helpers shared across unit-test modules.
#[cfg(test)]
pub(crate) mod test_log;
/// Domain types: memories, scopes, metadata, validation, and application state.
pub mod types;
/// Workspace bootstrap — scan a directory, index its text files, and write a
/// chunk dataset.
pub mod workspace;
