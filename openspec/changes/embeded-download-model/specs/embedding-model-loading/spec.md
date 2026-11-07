# Spec Delta

## Purpose

Loads the BGE-small-en-v1.5 embedding model files either from a local directory or automatically from HuggingFace Hub, caching downloads for subsequent starts.

## ADDED Requirements

### Requirement: Model files load from local directory when present

The system SHALL load `config.json`, `tokenizer.json`, and `model.safetensors` from a local directory resolved in this order:

1. `PALI_MODEL_DIR` environment variable
2. `<current-working-directory>/models/bge-small-en-v1.5`
3. `<platform local-data-dir>/memory-mcp/models/bge-small-en-v1.5`

#### Scenario: PALI_MODEL_DIR takes precedence

- **WHEN** `PALI_MODEL_DIR` is set to a directory containing all three model files
- **THEN** the engine loads the model from that directory
- **AND** no network download occurs

#### Scenario: CWD-relative directory is used when PALI_MODEL_DIR is unset

- **WHEN** `PALI_MODEL_DIR` is not set and `./models/bge-small-en-v1.5` exists with all three files
- **THEN** the engine loads the model from the CWD-relative directory
- **AND** no network download occurs

### Requirement: Automatic download from HuggingFace Hub on cache miss

The system SHALL download missing model files from HuggingFace Hub when the local directory does not contain all three required files, caching them in the standard HF cache directory (`HF_HOME`, defaults to `~/.cache/huggingface`).

#### Scenario: Cache miss triggers download

- **WHEN** the resolved local directory is missing any of `config.json`, `tokenizer.json`, or `model.safetensors`
- **THEN** the engine downloads the missing files from `https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/`
- **AND** the downloaded files are cached for subsequent starts

#### Scenario: HF_HOME and HF_ENDPOINT are respected

- **WHEN** `HF_HOME` is set to a custom path
- **THEN** downloaded model files are cached under that path
- **AND** `HF_ENDPOINT` is honored for self-hosted Hub mirrors

### Requirement: Manual provisioning remains the documented fallback

The system SHALL document `scripts/fetch-model.sh` as the explicit manual provisioning path for air-gapped or pre-baked deployments, and SHALL continue to support it without requiring any code changes.

#### Scenario: fetch-model.sh populates the local directory

- **WHEN** `scripts/fetch-model.sh` runs successfully
- **THEN** the resolved local directory contains all three model files
- **AND** the engine loads the model without any network download

### Requirement: Download progress is suppressed in headless mode

The system SHALL disable progress bars during download because it runs as a headless server.

#### Scenario: No interactive progress output

- **WHEN** the engine downloads model files
- **THEN** no progress bar or interactive output is written to stdout or stderr
- **AND** download status is logged via tracing

### Requirement: Download errors are actionable

The system SHALL return a typed error when download fails, naming the failed file, the HuggingFace repository, and the remediation steps.

#### Scenario: Network failure during download

- **WHEN** the HuggingFace Hub download fails due to network error
- **THEN** the engine returns an error indicating the failed file and repository
- **AND** the error message suggests running `scripts/fetch-model.sh` manually or checking network connectivity

### Requirement: First-run latency is documented

The system SHALL document that the first run may block for approximately one minute while downloading the ~130 MB model, and that `pali warmup` can be used to pre-populate the cache.

#### Scenario: warmup pre-populates the cache

- **WHEN** `pali warmup` runs before the first server start
- **THEN** the model files are downloaded and cached
- **AND** subsequent server starts load from cache without network access
