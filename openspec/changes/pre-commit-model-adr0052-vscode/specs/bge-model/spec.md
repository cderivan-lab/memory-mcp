# Specification: BGE Model Provisioning

## ADDED Requirements

### Requirement: REQ-411 Model Config

- **ID**: REQ-411
- **Description**: `models/bge-small-en-v1.5/config.json` present with valid BERT config
- **Rationale**: Model architecture definition

#### Scenario: Model config present

- **WHEN** the model config is checked
- **THEN** it is present with valid BERT config

### Requirement: REQ-412 Tokenizer

- **ID**: REQ-412
- **Description**: `models/bge-small-en-v1.5/tokenizer.json` present with WordPiece vocab
- **Rationale**: Text tokenization

#### Scenario: Tokenizer present

- **WHEN** the tokenizer is checked
- **THEN** it is present with WordPiece vocab

### Requirement: REQ-413 Model Weights (provisioned, not committed)

- **ID**: REQ-413
- **Description**: `models/bge-small-en-v1.5/model.safetensors` present locally (~130MB) after provisioning, and gitignored (absent from git)
- **Rationale**: Model parameters; kept out of git per ADR-0049 (remote 100MB limit, no LFS)

#### Scenario: Model weights provisioned

- **WHEN** the model weights are checked
- **THEN** they are present locally and gitignored

### Requirement: REQ-414 Model Loading

- **ID**: REQ-414
- **Description**: `src/embedding/candle.rs` loads from `PALI_MODEL_DIR` or `./models/bge-small-en-v1.5/`
- **Rationale**: Flexible model location

#### Scenario: Model loading

- **WHEN** the model is loaded
- **THEN** it loads from the configured location

### Requirement: REQ-415 Offline Operation

- **ID**: REQ-415
- **Description**: No HF Hub download at runtime when model present locally
- **Rationale**: Air-gapped / offline environments

#### Scenario: Offline operation

- **WHEN** the model is used in offline mode
- **THEN** no HF Hub download occurs at runtime

## Model Spec

| File | Size | In git | Purpose |
| ------ | ------ | -------- | --------- |
| config.json | ~1KB | yes | Architecture config |
| tokenizer.json | ~700KB | yes | WordPiece vocab |
| model.safetensors | ~130MB | no (gitignored) | Model weights, fetched via fetch-model.sh |

## Acceptance Criteria

- [ ] `config.json` and `tokenizer.json` committed in `models/bge-small-en-v1.5/`
- [ ] `model.safetensors` present locally after `scripts/fetch-model.sh` (or extension install)
- [ ] `model.safetensors` is gitignored and absent from `git ls-files`
- [ ] `config.json` has `"architectures": ["BertModel"]`
- [ ] `tokenizer.json` has valid vocab structure
- [ ] `model.safetensors` loads via `candle::safetensors::load`
- [ ] `PALI_MODEL_DIR=/custom/path` loads from custom location
- [ ] Default `./models/bge-small-en-v1.5/` works without env var
- [ ] No network call to hf.co at model load time
