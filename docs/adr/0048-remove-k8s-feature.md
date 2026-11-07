# ADR-0048: Remove the Kubernetes Secret token store

## Status
Accepted

Amended by [ADR-0050](0050-minimal-local-core.md): the keyring, file, and
stdout token backends and the `pali auth` command were removed with OAuth
token handling. Only `PALI_GIT_TOKEN` remains.

## Context
ADR-0013 added `--store k8s-secret`, feature-gated behind a `k8s` cargo
feature, to write the GitHub token into an Opaque Kubernetes Secret. It existed
to support the in-cluster server deployment, whose pod spec mounted that Secret
as `PALI_GITHUB_TOKEN`.

ADR-0047 removed the HTTP transport and the Kubernetes manifests: Pali serves
stdio, one process per client, launched with `docker run -i`. There is no
long-lived deployment to inject a Secret into, and no documented deployment
path uses the k8s store. The feature nevertheless kept `kube` and `k8s-openapi`
in the optional dependency graph and preserved an HTTP-cluster-only CLI and API
surface.

Alternatives considered:

1. **Keep the feature** (status quo). Rejected: it serves a deployment model the
   project no longer documents or ships, at the cost of two large optional
   dependency trees and a semver-visible surface that must stay green in CI.
2. **Keep it behind an additional feature flag.** Rejected: the feature is
   already opt-in; the problem is the code and dependencies, not the default
   build.
3. **Remove the feature, store backend, and dependencies.** Chosen.

## Decision
Remove the `k8s` cargo feature, the `kube` and `k8s-openapi` dependencies, the
`StoreBackend::K8sSecret` variant, `K8sSecretConfig`, and the
`--store k8s-secret`, `--k8s-namespace`, and `--k8s-secret-name` flags.

Token storage keeps the keyring, file, and stdout backends. An environment that
still needs a Secret can pipe `--store stdout` into `kubectl create secret`.

## Consequences
- Breaking for Rust consumers: the `StoreBackend::K8sSecret` variant and the
  `K8sSecretConfig` type are gone, so exhaustive matches over `StoreBackend`
  no longer compile against them.
- Default and `otlp` builds lose no functionality. Release binaries and the
  container image no longer carry a Kubernetes client.
- The dependency graph, `cargo deny` inputs, and CI matrices no longer include
  kube, kube-client, kube-core, or k8s-openapi.
- ADR-0013 is superseded. The statement in ADR-0047 that the `k8s` feature is
  unaffected is superseded by this decision.
