# Spec Delta

## Purpose

Delegate embedding-model provisioning entirely to the `pali` server. The
extension previously downloaded a model zip from a GitHub raw URL and
unpacked it; the server already owns model resolution and download from
HuggingFace Hub (ADR-0051), so the extension's second download machine is
removed.

## ADDED Requirements

### Requirement: The extension does not provision the embedding model

The extension SHALL NOT download, extract, validate, or bundle the embedding
model. Model resolution, including HuggingFace Hub downloads, is owned by the
server per ADR-0051. The `pali.modelPath` setting remains a user override
exported to the server as `PALI_MODEL_DIR`; an unusable value is reported and
cleared so the server resolves the model itself.

#### Scenario: No model download during binary setup

- **WHEN** the extension downloads and installs the `pali` binary release
- **THEN** no model file is fetched, extracted, or written by the extension
- **AND** the server resolves the embedding model on first use

#### Scenario: An unusable pali.modelPath falls back to server resolution

- **WHEN** `pali.modelPath` is set to a directory missing one of the model
  files
- **THEN** activation reports which files are missing and clears the
  `PALI_MODEL_DIR` environment variable for the server
- **AND** the server falls back to its own model resolution (local directory
  or HuggingFace download)

#### Scenario: A valid pali.modelPath is exported to the server

- **WHEN** `pali.modelPath` points at a directory containing all model
  files
- **THEN** the server receives it as `PALI_MODEL_DIR` and loads the model
  from that directory without a network download
