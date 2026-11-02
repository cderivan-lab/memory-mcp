# TODO

## Phase 1: Core + Semantic from the start

- [ ] Scaffold Rust MCP server with stdio transport
- [ ] Define memory file format (markdown + YAML frontmatter for tags, timestamps, source)
- [ ] Implement memory repo management (init, open existing, commit)
- [ ] Choose local embedding model (e.g. fastembed-rs / ort with a small model)
- [ ] Build embedding index alongside storage from the start
- [ ] Implement `remember` — write file, commit, embed, index
- [ ] Implement `recall` — semantic search by default, with optional tag/scope filters
- [ ] Implement `forget` — delete file, commit, remove from index
- [ ] Implement `list` — for parity with Serena's list_memories (browsing, not primary retrieval)
- [ ] Implement `read` — read a specific memory by name (parity with Serena's read_memory)

## Phase 2: Sync + Migration

- [ ] Implement git sync (pull, push, conflict handling)
- [ ] Index rebuild on pull (incremental if possible)
- [ ] Migration tool: import Serena global memories (preserve content + metadata)
- [ ] Migration tool: import Serena project-scoped memories
- [ ] Migration tool: import Claude Code auto-memories
- [ ] Configure as MCP server in `~/.claude.json`
- [ ] Update CLAUDE.md instructions to use memory-mcp instead of Serena memories
- [ ] Test cross-device sync workflow

## Phase 3: Polish

- [ ] Deduplication / update detection on `remember` (semantic similarity threshold)
- [ ] Memory metadata enrichment (last-accessed, access count, confidence)
- [ ] Scoped recall (global vs project-specific filtering)
- [ ] Periodic background sync
- [ ] CLI for manual memory management outside of agent sessions
- [ ] `edit` tool — modify existing memory in place
