# Tasks

## 1. Core Binary Resolution Logic (lib.js)

- [ ] 1.1 Add `resolvePaliBinary(context, config)` function to `vscode-extension/lib.js` that checks binPath, PATH, and globalStorage cache — verify with unit test mocking fs/which
- [ ] 1.2 Add `getReleaseTarget(platform, arch)` helper returning release target string or null for unsupported platforms — verify with test matrix for darwin-x64, darwin-arm64, linux-x64, win32-x64

## 2. Download & Install Implementation (extension.js)

- [ ] 2.1 Add `downloadAndInstallPali(context)` function using Node.js fetch with progress reporting via `vscode.window.withProgress` — verify manual test shows progress notification
- [ ] 2.2 Add `installBinary(context, binaryBuffer)` to write to `<globalStorage>/pali` with executable permissions (0o755) — verify file exists and is executable after install
- [ ] 2.3 Add `updateBinPathSetting(newPath)` to update `pali.binPath` in global config and fire `serverChanged` — verify setting updated and MCP provider returns new path

## 3. User Notification & Prompting (extension.js)

- [ ] 3.1 Add `promptForDownload(context)` showing modal with "Download Now", "Open Settings", "Later" — verify each action triggers correct behavior in manual test
- [ ] 3.2 Integrate prompt into extension activation: call `resolvePaliBinary` on activate, if missing call `promptForDownload` — verify first-run experience on machine without pali

## 4. Error Handling & Edge Cases

- [ ] 4.1 Add download error handling: network errors, HTTP errors, partial write cleanup — verify error message shown with manual install instructions
- [ ] 4.2 Add binary validation: if cached binary fails to execute, treat as missing and re-prompt — verify corrupted binary triggers re-download

## 5. Settings Integration

- [ ] 5.1 Ensure `pali.binPath` setting exists in `package.json` configuration schema (already exists, verify schema allows string path) — verify settings UI shows binPath
- [ ] 5.2 Handle binPath change event: if user manually changes binPath, re-resolve binary — verify changing setting triggers re-resolution

## 6. Verification & Integration Tests

- [ ] 6.1 Add unit tests for `resolvePaliBinary` scenarios (configured, PATH, cache, missing) — run `npm test` to verify
- [ ] 6.2 Add unit tests for `getReleaseTarget` platform matrix — run `npm test` to verify
- [ ] 6.3 Manual integration test: uninstall pali, reload extension, verify download prompt → install → server restart works — verify end-to-end flow

## 7. Documentation

- [ ] 7.1 Update `vscode-extension/README.md` with auto-install feature description and manual override instructions — verify README renders correctly

## Workflow follow-up

- Archive the change after implementation and review are complete.
- Verify archived result appears in main specs.