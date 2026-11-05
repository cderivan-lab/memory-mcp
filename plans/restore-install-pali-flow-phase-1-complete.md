# Phase 1 Complete: Restore successful installation flow

Restored a working `installLatest` flow that resolves the latest release asset through GitHub’s authenticated API, downloads and extracts the binary, records install metadata, offers model provisioning, and prompts for reload. Latest-release lookup failures now remain distinct from a missing asset.

## Files created/changed

- `src/utils/install_pali.ts`
- `test/extension.test.js`
- `plans/restore-install-pali-flow-plan.md`
- `plans/restore-install-pali-flow-phase-1-complete.md`

## Functions created/changed

- `installLatest`
- `fetchLatestRelease`
- `fetchLatestVersion`
- Release asset lookup and install error handling

## Tests created/changed

- Authenticated direct release-asset API install and setup
- Latest-release API failure is reported distinctly
- Existing install tests updated for direct API download behavior

**Verification:** `npm test` (77 passed), `npm run compile`, diagnostics, and `git diff --check` all passed.

**Review Status:** APPROVED with minor test-coverage recommendations; the missing-asset regression is scheduled for Phase 3.

## Git Commit Message

fix: restore the Pali install flow

- Complete authenticated asset installation and setup
- Surface release lookup failures during install
- Cover direct API and install error paths
