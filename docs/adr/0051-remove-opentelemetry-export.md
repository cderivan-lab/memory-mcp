# ADR-0051: Remove OpenTelemetry/OTLP span export

## Status
Accepted

## Context
ADR-0006 established structured `tracing` spans written to stderr as the
observability baseline. An `otlp` cargo feature later added an OpenTelemetry
layer on top of the same subscriber: `--otlp-required` / `--otlp-optional`
flags, a startup TCP reachability probe for `--otlp-required`, sanitized
endpoint reporting for exporter construction failures, and the standard
`OTEL_EXPORTER_OTLP_*` endpoint variables.

Since then the deployment model narrowed. ADR-0047 made stdio the only
transport, so Pali is one local process per client launched by an MCP client.
ADR-0050 removed the container image and CI, leaving a local binary with no
long-lived deployment to attach a collector to. No documented install path
configures OTLP, and the feature was compiled in but inert unless a flag
activated it.

The cost is concrete:

- Four optional crates pinned in lockstep, with `opentelemetry-otlp` pulling
  the tonic/prost/protobuf gRPC stack into the optional dependency graph.
- `reqwest`, whose only consumer in the tree was the startup endpoint probe.
- Roughly 350 lines in `src/main.rs` (endpoint resolution and sanitization,
  the deadline-bounded probe, exporter construction and failure paths), a
  process-level test file, two CLI flags with matching environment variables,
  and a permanent feature-matrix obligation for every gate.

Alternatives considered:

1. **Keep the feature** (status quo). Rejected: it exists for a deployment
   shape the project no longer ships or documents, and 400+ lines of
   probe/sanitization logic would need to stay green forever.
2. **Keep the flags but drop the probe.** Rejected: the probe was the only
   reason "required" differed from "optional"; without it the two flags
   collapse into one, which is still surface with no consumer.
3. **Remove the feature, flags, and dependencies; keep `tracing`.** Chosen.

## Decision
Remove the `otlp` cargo feature, the `--otlp-required` and `--otlp-optional`
flags, the `PALI_OTLP_REQUIRED` / `PALI_OTLP_OPTIONAL` variables (and their
legacy `MEMORY_MCP_*` mappings), the `opentelemetry`, `opentelemetry_sdk`,
`opentelemetry-otlp`, and `tracing-opentelemetry` dependencies, and the
`reqwest` dependency that only parsed collector URLs. `tests/otlp_startup.rs`
and the OTLP unit tests in `src/main.rs` are deleted.

`init_tracing()` is now a single unconditional function: `Registry` +
`EnvFilter` + `fmt` to stderr, initialised once in `main` for every
subcommand.

Structured spans, span naming (`module.operation`), field naming, `RUST_LOG`
filtering, and the redaction requirements (R-16–R-18) are unchanged. An
operator who wants trace export can forward stderr to any log pipeline; a
deployment that specifically needs OTLP can add a `tracing` layer downstream.

## Consequences
- Breaking for users: the two flags and their variables are gone, so a
  command line or environment that still sets them fails at startup instead
  of silently ignoring them. `cargo build --features otlp` fails because the
  feature no longer exists.
- The dependency graph, `Cargo.lock`, and `cargo deny` inputs lose the
  OpenTelemetry crates, tonic/prost/protobuf, and the optional HTTP client.
  No license or advisory posture changes.
- Documentation drops the OTLP build instruction and flag table row. The
  tracing design artifacts keep their OTLP requirements and test cases as
  history, marked non-binding.
- ADR-0050's clause that `reqwest` stays for the `otlp` feature and
  ADR-0014's update note about compiling with `--features otlp` are
  superseded. ADR-0006's decision to emit structured spans from day one
  stands.
