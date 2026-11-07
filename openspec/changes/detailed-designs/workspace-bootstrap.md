# Detailed Design: Workspace Bootstrap

## Change: add-workspace-bootstrap

### Purpose

Before any recall works, a workspace needs local groundwork: an inventory of its readable text files with secrets withheld, an embeddable chunk store, and an exportable dataset.

### New Capability: `workspace-bootstrap`

#### Core Components

- **`pali::workspace` module**: content-safe file scan, line-window chunking, embedding-index build, and dataset export over one shared file-selection pipeline
- **CLI commands**: `pali scan`, `pali index`, `pali dataset` sharing workspace/artifacts/limit arguments
- **Extension commands**: `Pali: Scan Workspace` (`pali.scan`) and `Pali: Index Workspace` (`pali.index`)

#### File Selection Pipeline

1. **Scan workspace root**: enumerate all files through git (tracked + untracked, excluding git-ignored, not following nested repos)
2. **Filter sensitive content**: exclude whole files matching sensitive path patterns or credential content rules
3. **Line-window chunking**: split accepted files into overlapping line windows for embedding
4. **Build embedding index**: store chunks under `pali`-owned names (`workspace/<path:start-end>`) in the scope-rooted usearch store
5. **Export dataset**: output chunks as JSONL for external consumption

#### Artifacts

Under the workspace artifacts directory (default `.pali/`):

- `scan.json` — enumerated files with metadata (language, size, sensitivity status)
- `index/` — embedding index store
- `chunks.jsonl` — JSONL export of all chunks with file paths, line ranges, and content summaries
- `dataset.jsonl` — full dataset export for model training or analysis

#### CLI Arguments (shared across scan/index/dataset)

- `--workspace <path>`: Root workspace path (default: current directory)
- `--artifacts <path>`: Artifacts directory (default: `.pali/`)
- `--limit <N>`: Maximum number of files to process
- `--chunk-size <N>`: Chunk size in lines (default: configured window)
- `--chunk-overlap <N>`: Overlap between consecutive chunks (default: configured overlap)
- `--exclude <pattern>`: Additional file path exclusion pattern

#### Index Requirements

- `pali index` requires a provisioned embedding model
- Respects `pali.logLevel` diagnostics for dimension mismatches
- Vector index stored under `pali`-owned names in the scope-rooted usearch store
- Chunks exported as JSONL with path, line range, language, and content preview

### Design Rationale

- Shared pipeline across scan/index/dataset avoids redundancy
- Content safety: secrets withheld at scan time, never redacted later
- Deterministic chunking ensures reproducible indices
- Scope-rooted usearch store enables per-project indexing
