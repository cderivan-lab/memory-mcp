# Proposal: Extension no longer downloads the embedding model

## Why

The VS Code extension shipped a second copy of the embedding model
provisioning: it downloaded a `bge-small-en-v1.5.zip` from a GitHub raw URL,
validated zip magic bytes, and unpacked it into a model directory it then
exported to the server as `PALI_MODEL_DIR`. The server already owns this
exact path — `src/embedding/candle.rs` resolves `PALI_MODEL_DIR`,
`./models/bge-small-en-v1.5`, and the local data dir, and downloads missing
files from HuggingFace Hub via `hf-hub` on first use (ADR-0051). Two download
machines for one artifact means two failure modes, two code paths to keep in
sync, and ~250 lines of extension code (zip fetch, magic-byte check, "Download
now" offer, `resolveModelDir`) whose only consumer was the model.

## What Changes

- The extension no longer downloads, extracts, or validates the embedding
  model. Removed from `src/utils/install_pali.ts`: the model zip URL
  builder, `installModel`, the zip magic-byte validation, and the
  "Download now" notification offer.
- `src/model-manifest.json` and `resolveModelDir` are deleted; the model
  directory the extension used to export is gone from the install result.
- The server still honors `PALI_MODEL_DIR` (and `HF_HOME` / `HF_ENDPOINT`)
  exactly as before — the server-side download path is unchanged.
- `pali.modelPath` is now a plain user override: if the user points it at a
  directory that is not usable, activation names what is missing and clears
  it, letting the server resolve the model itself (local dir or HF download).
- Binary-release download/verification is untouched and still owned by the
  extension.

## Impact

- Affected specs: `vscode-extension-pali-auto-install` (new requirement: the
  extension MUST NOT provision the embedding model).
- Affected code: `src/extension.ts`, `src/utils/install_pali.ts`,
  `src/utils/lib.ts`, `src/model-manifest.json` (deleted),
  `test/extension.test.js`, `test/extension.activation.test.js`,
  `package.json` (e2e devDependency removed), `README.md`, `CHANGELOG.md`.
- Removed e2e coverage: `test/e2e-ui/download-notification.test.js` and the
  `vscode-extension-tester` devDependency (the flow under test no longer
  exists).

## Tasks

- [x] 1.1 Delete TS model-zip machinery from `install_pali.ts`
      (`modelZipUrl`, `installModel`, magic-byte check, "Download now" offer,
      `resolveModelDir`, `src/model-manifest.json`)
- [x] 1.2 Simplify `install.ts` / `extension.ts` / `lib.ts` install wiring
      (no `modelDir` in the install result; `pali.modelPath` becomes a
      validated user override)
- [x] 1.3 Update `test/extension.test.js` and
      `test/extension.activation.test.js`; delete
      `test/e2e-ui/download-notification.test.js` and the
      `vscode-extension-tester` devDependency
- [x] 1.4 Update README, CHANGELOG, and extension description to document
      server-owned HF download (`PALI_MODEL_DIR` / `HF_HOME` / `HF_ENDPOINT`
      honored, ADR-0051)
- [x] 1.5 `npm run compile` green; `npm test` matches the known 14-failure
      Windows baseline (no regressions)
