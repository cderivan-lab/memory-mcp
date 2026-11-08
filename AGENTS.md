# Agent Instructions

## Authority and orientation

- Explicit maintainer direction for the current task supersedes repository guidance. If they conflict, surface the conflict and update the durable guidance; do not silently choose the older rule.
- Read the ADRs applicable to the area you are changing. Respect their status: **Accepted** decisions are binding, **Proposed** decisions are context, and **Superseded** decisions are historical. If an Accepted ADR conflicts with current code, workflows, or maintainer direction, flag it for reconciliation.

## Layout

- The VS Code extension at the repository root is the product: `package.json`,
  `src/` (TypeScript), `test/`, `hooks/`, and `images/`.
- The server crate lives in `pali/`. The root `Cargo.toml` is a virtual
  workspace that exists so crate commands still run from the root.
- `npm run build:binary` compiles the crate and stages `out/bin/pali`;
  `npm run build` does that plus the TypeScript compile, and the packaged VSIX
  ships the staged binary. Downloading a release binary is the fallback path.

## Pre-commit

A `.githooks/` hook runs local checks before every commit. Activate and verify it once per clone:

```sh
git config core.hooksPath .githooks
git config --get core.hooksPath
```

The hook runs, in order:

1. `cargo fmt -- --check`
2. `cargo clippy -- -D warnings`
3. `cargo doc --no-deps`, rejecting warnings
4. `gitleaks protect --staged` when `gitleaks` is installed; otherwise it warns and continues

## Verification

- Canonical full suite: `cargo nextest run --workspace --no-fail-fast`. Do not substitute `cargo test` for the full-suite receipt.
- For code changes, run the feature combinations affected by the change. Before declaring a code-changing PR ready, cover default and all-features; mirror the full CI feature matrix when changing feature-gated behavior.
- Use in-process tests (`tower::ServiceExt::oneshot`) for handler behavior. Use subprocess tests when process startup or shutdown is the behavior under test.
- Use `#[tokio::test(start_paused = true)]` for deterministic timer, timeout, and backoff semantics when compatible. Use bounded real-time polling for multi-thread scheduling or convergence behavior that paused time cannot represent.
- Tests must be non-vacuous: name the regression that would turn each important test red.
- Dependency or feature changes must preserve the declared MSRV, pass applicable `cargo deny` checks, and preserve the TLS, vendoring, and dependency constraints in the relevant Accepted ADRs.

## Code style

- `#![warn(missing_docs)]` — all public items need doc comments.
- Encode invariants in the type system: prefer domain newtypes over primitives, validate at boundaries, and use typed values internally.
- Default to `pub(crate)`; every `pub` item is a semver commitment and needs an external consumer.
- Public enums are exhaustive by default. Adding a variant is an intentional breaking interface change so downstream exhaustive matches fail to compile. Use `#[non_exhaustive]` only when that specific API explicitly chooses forward-compatible matching. Treat public structs separately based on their contract.
- Prefer `impl Into<String>` for constructor parameters that take ownership of string data; do not apply it mechanically to every API.
- Test comments should explain non-obvious contracts, race windows, or failure models. Do not narrate obvious mechanics or preserve historical trivia in canonical code.

## Error handling and tracing

- Use the most specific `MemoryError` variant. `InvalidInput` is for caller validation failures; `Internal` is only for unexpected failures without a better variant.
- Propagate recoverable input, I/O, protocol, and dependency failures with typed errors.
- `expect` or `unreachable!` is reserved for documented internal invariants or unrecoverable poisoned state where continuing could propagate corruption. Never panic for a recoverable external failure.
- Tracing follows `docs/design/tracing/requirements.md`: span names use `module.operation` (R-02); never record tokens, credentials, API keys, full memory content, or unredacted credential-bearing URLs (R-16–R-18).

## API surface and semver

- Use constructors for validated or invariant-bearing domain types. Public fields are acceptable for intentionally data-like wire DTOs and transparent result aggregates.
- Minimize the public surface: fewer public items mean fewer compatibility commitments.
- For a public-API change, run semver checks with the same feature coverage as CI (default plus explicit `otlp`). Intentional breaking changes require explicit maintainer approval, the appropriate version bump, and migration/changelog material.

## CI and pull requests

- `cargo fmt --check` is advisory in CI: the `lint` job runs it only when the
  `fmt-check` workflow-dispatch input is set or the `FMT_CHECK` repository
  variable is `true`. rustfmt's line breaking changes between releases, so the
  runner's toolchain can reformat lines the author's toolchain accepts. The
  pre-commit hook is the formatting gate.
- `.github/workflows/release.yml` owns tag pushes: it builds the Linux and universal macOS binaries plus one VSIX per platform and attaches them to the release. `.github/workflows/build-binaries.yml` builds the same binary set on `workflow_dispatch` for ad-hoc use (including Windows) and never uploads to a release. The remaining gates in `CONTRIBUTING.md` (fmt, clippy, docs, nextest, feature checks) are run locally and recorded in the PR.
- PR titles use an allowed Conventional Commit type, `!` for a breaking change, and no angle brackets.
- If workflows are reintroduced, pin third-party actions to full commit SHAs, preserve deny-by-default and least-privilege permissions, and never run untrusted PR code through `pull_request_target`.
- A semver-check failure is a gate, not a ban on intentional breaking changes. Approved breaks ship with the correct version transition.

## Releases

- The maintainer owns merges and version-bump approval. Never merge, tag, publish, or invoke a release command without explicit authorization.
- After an approved version bump reaches `main` and the local gates pass, the maintainer creates the tag and publishes release artifacts.
- A version-bump/release change updates `CHANGELOG.md` for everything since the previous tag.
- Stacked PRs keep separate concerns in separate PRs and merge in dependency order against the correct base branches.

## ADRs

For a design decision where alternatives were seriously weighed, add an ADR in `docs/adr/` using the next available number and existing format. Record the decision, alternatives, tradeoffs, and consequences. When policy changes, supersede or amend the affected ADR so stale Accepted text does not remain binding.

## Code review

1. The implementer runs a review-fix loop before announcing the change.
2. A sibling performs the independent certification review using the review capability available in their environment.
3. Triage every finding. Fix accepted findings; record and escalate genuine disagreements instead of making a harmful change to satisfy a review counter.
4. Any artifact or governing-instruction change invalidates the prior review receipt. Re-review the exact new head.
5. Repeat until an independent review of the exact current head reports zero findings at or above Low severity.

The maintainer remains the merge latch. A green test run or an author's self-review is not merge authorization.

## Session learnings — 2026-11-08 (pali git2/HF restructure)

Durable facts and decisions from the `refactor/pali-git2-hf-restructure` session:

- **git2 only** (no gix): ADR-0054 supersedes ADR-0053. Keep the server on a single git backend.
- **Model download is server-owned**: the Rust server downloads the HuggingFace model; no model-download code in TypeScript. Model/embedder warmup runs via the `pali warmup` CLI subcommand.
- **`test:e2e` compiles TypeScript first** (`compile:tests && vscode-test`). `npm run build:binary` builds the Rust binary only and does NOT recompile TS — a stale `out/` previously drove e2e results silently (root cause of the Mac "bundled path wins" e2e failure, fixed `af55163`). If e2e behavior contradicts the source, suspect a stale `out/` before suspecting the fix.
- **`resolvePaliBinary` precedence**: explicitly configured `pali.path` (gated by `isExecutable`) → bundled `out/bin/pali` → PATH (default "pali" only) → globalStorage cache (HTML-login-page check) → missing. Do not reorder: the configured path must win over the bundled one.
- **Rust tests stay inline** (`#[cfg(test)] mod tests` in source files) — explicit maintainer choice; do not move them to a separate test folder as part of the restructure.
- **Comment policy**: keep crate/module `//!` docs, `///` on `pub` items, and only comments documenting non-obvious contracts, race windows, invariants, failure models, or ADR references. Remove narrative/trivial comments.
- **KISS / net code reduction** is a binding constraint of the restructure: move-only restructuring, no new abstractions; fewer lines preferred.
- **100% test coverage** is the final stage, to be reached after the module restructure completes — not before.
- **Known test-gate quirk**: `hooks/test/*.test.mjs` use `node:test` but are loaded by mocha, so subtest failures print `✖` without failing the suite's exit code. `npm test` exiting 0 does not guarantee those subtests pass; check their output explicitly.
- **Known gap (deferred)**: copilot-hooks work in the VS Code harness only; Copilot CLI hook events are not currently reached. Track separately after the restructure.

