//! Drift guard for the model layout the loader and the VS Code installer share.
//!
//! `src/model-manifest.json` is embedded by the loader (this crate) and imported
//! by the extension's installer, so the two cannot disagree about the directory
//! or file names. These assertions catch a manifest edit that leaves the names
//! unusable while both sides still compile: an empty entry, a path that escapes
//! the model directory, or a directory name that no longer matches the
//! HuggingFace repository the id names.

const MANIFEST: &str = include_str!("../../src/model-manifest.json");

#[derive(serde::Deserialize)]
struct ModelFiles {
    config: String,
    tokenizer: String,
    weights: String,
}

#[derive(serde::Deserialize)]
struct ModelManifest {
    id: String,
    dir: String,
    files: ModelFiles,
}

#[test]
fn manifest_describes_a_usable_loader_layout() {
    let manifest: ModelManifest =
        serde_json::from_str(MANIFEST).expect("src/model-manifest.json must be valid JSON");

    // The binary reports MODEL_ID in its tracing spans and update messages; the
    // manifest is what the loader actually resolves on disk.
    assert_eq!(manifest.id, pali::embedding::MODEL_ID);

    // The repository name in the id is the conventional directory name; a model
    // swap that updates one without the other would provision a directory the
    // loader never looks in.
    let repo_name = manifest.id.rsplit('/').next().unwrap_or_default();
    assert_eq!(manifest.dir, repo_name);

    let names = [
        &manifest.files.config,
        &manifest.files.tokenizer,
        &manifest.files.weights,
    ];
    for (index, name) in names.iter().enumerate() {
        let name = name.as_str();
        assert!(!name.is_empty(), "every required model file must be named");
        assert!(
            !name.contains(['/', '\\']) && name != "..",
            "{name} must be a bare file name inside the model directory"
        );
        assert!(
            !names[index + 1..]
                .iter()
                .any(|other| other.as_str() == name),
            "duplicate required model file: {name}"
        );
    }
}
