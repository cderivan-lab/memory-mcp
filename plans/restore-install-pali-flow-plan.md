# Plan: Restore Pali Installer Flow

Repair the malformed installer section while preserving the local move to the token-authenticated release asset API. Add focused regressions first, then verify the complete install and update-check behavior without replacing unrelated workspace edits.

## Phases

### Phase 1: Restore successful installation flow

- **Objective:** Re-establish the complete `installLatest` callback and its post-install steps, preserving the direct release-asset API download behavior.
- **Files/Functions:** `src/utils/install_pali.ts` (`installLatest`, `normalizeVersion` boundary); `test/extension.test.js` (install success coverage).
- **Test:** A successful direct-asset-API install test that checks authorization, extraction, maintenance metadata, and reload notification.
- **Steps:**
  1. Add or adapt the focused regression test and run it to capture the current failure.
  2. Restore the complete installation flow and valid function boundaries with minimal changes.
  3. Run the focused install test and TypeScript compilation.

### Phase 2: Cover equivalent release versions

- **Objective:** Ensure `v`-prefixed and unprefixed versions compare as equal and do not trigger a redundant update prompt.
- **Files/Functions:** `src/utils/install_pali.ts` (`normalizeVersion`, `checkUpdates`); `test/extension.test.js` (update-check coverage).
- **Test:** An update-check regression where installed and latest tags differ only by a leading `v`, asserting no prompt.
- **Steps:**
  1. Add the regression and run it to demonstrate the missing behavior.
  2. Make the smallest comparison fix required.
  3. Run the update-check tests and TypeScript compilation.

### Phase 3: Cover missing release asset failure

- **Objective:** Keep direct API lookup failures actionable and ensure they do not leave partial install artifacts.
- **Files/Functions:** `src/utils/install_pali.ts` (`installLatest` asset lookup); `test/extension.test.js` (install failure coverage).
- **Test:** A missing latest-release asset case that asserts the actionable error and absence of an installed binary/archive.
- **Steps:**
  1. Add the failure-path regression and run it to observe the current behavior.
  2. Adjust error handling only if needed to satisfy the contract.
  3. Run focused installer tests and the project test suite.

## Open Questions

- None; the approved scope is to preserve the direct release-asset API approach already present in the local edit.
