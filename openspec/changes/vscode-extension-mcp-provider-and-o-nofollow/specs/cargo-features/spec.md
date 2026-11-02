# Spec Delta

## Purpose

The `pali` cargo feature surface: the empty `native-certs` feature is removed
because it gated nothing after ADR-0049 removed automatic model download.

## ADDED Requirements

### Requirement: `--features native-certs` SHALL not be a valid feature

The feature is removed from `Cargo.toml`; passing it to cargo MUST fail the build.

#### Scenario: build invocation with the removed feature

- **WHEN** a build or test invocation passes `--features native-certs`
- **THEN** cargo reports an unknown feature and the build fails

## MODIFIED Requirements

(none — the removal is a breaking change to the build surface, documented in
the CHANGELOG; no runtime requirement changes)