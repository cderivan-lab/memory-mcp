# Spec Delta

## Purpose

Lets the VS Code extension automatically detect a missing pali binary, download a prebuilt release matching the host architecture, install it to persistent storage, and restart the MCP server — making the extension work out of the box without manual CLI installation.

## ADDED Requirements

### Requirement: Binary detection at startup

The extension SHALL check for a usable pali binary when the extension activates and whenever the `pali.binPath` setting changes.

#### Scenario: Configured binPath exists and is executable

WHEN the extension activates AND `pali.binPath` points to an executable file
THEN the extension SHALL use that binary without prompting.

#### Scenario: Configured binPath missing

WHEN the extension activates AND `pali.binPath` points to a non-existent file
THEN the extension SHALL fall back to PATH lookup.

#### Scenario: Binary found on PATH

WHEN the extension activates AND `pali.binPath` is unset or invalid AND `pali` is found on PATH
THEN the extension SHALL use the PATH binary and update `pali.binPath` to the resolved absolute path.

#### Scenario: Binary not found anywhere

WHEN the extension activates AND no pali binary is found at configured path nor on PATH
THEN the extension SHALL mark binary as missing and trigger the download prompt.

### Requirement: Architecture-aware download

The extension SHALL download a prebuilt pali binary matching the host platform and architecture from the configured release server.

#### Scenario: Download on macOS x64

WHEN download starts on macOS x64
THEN the extension SHALL request the `universal-apple-darwin` binary.

#### Scenario: Download on macOS arm64

WHEN download starts on macOS arm64
THEN the extension SHALL request the `universal-apple-darwin` binary.

#### Scenario: Download on Linux x64

WHEN download starts on Linux x64
THEN the extension SHALL request the `x86_64-unknown-linux-gnu` binary.

#### Scenario: Unsupported platform

WHEN download starts on Windows
THEN the extension SHALL show an error that prebuilt binaries are not available for Windows and provide manual install instructions.

### Requirement: Persistent installation to globalStorage

The extension SHALL save the downloaded binary to VS Code's `globalStorage` directory so it persists across extension reloads and VS Code restarts.

#### Scenario: Binary saved to globalStorage

WHEN download completes successfully
THEN the extension SHALL write the binary to `<globalStorage>/pali` with executable permissions.

#### Scenario: Binary reused on restart

WHEN the extension activates AND a pali binary exists at `<globalStorage>/pali`
THEN the extension SHALL use that binary without re-downloading.

### Requirement: Automatic settings update

The extension SHALL update the `pali.binPath` setting to point to the installed binary after successful download.

#### Scenario: binPath updated to globalStorage binary

WHEN download and install complete
THEN the extension SHALL call `workspace.getConfiguration('pali').update('binPath', installedPath, true)` where `installedPath` is the absolute path to `<globalStorage>/pali`.

#### Scenario: User notified of automatic update

WHEN binPath is automatically updated
THEN the extension SHALL show an information message confirming the biinary was installed and the setting updated.

### Requirement: MCP server restart after install

The extension SHALL fire the server change event so VS Code re-requests the MCP server definition with the new binary path.

#### Scenario: Server restarted with new binary

WHEN binPath is updated to the downloaded binary
THEN the extension SHALL fire `serverChanged.fire()` so the MCP server definition provider returns the new path.

### Requirement: User-facing download notification

The extension SHALL present a modal notification offering to download pali when the binary is missing.

#### Scenario: Modal notification shown

WHEN extension activates AND pali binary is missing AND no download is in progress
THEN the extension SHALL show a modal information message with actions: "Download Now", "Open Settings", "Later".

#### Scenario: Download initiated on user confirmation

WHEN user clicks "Download Now"
THEN the extension SHALL start the download with progress reporting.

#### Scenario: Settings opened on user choice

WHEN user clicks "Open Settings"
THEN the extension SHALL open the pali configuration section in settings.

#### Scenario: Download deferred on user choice

WHEN user clicks "Later" or dismisses the notification
THEN the extension SHALL defer the prompt for this session and not re-prompt until next extension activation.

### Requirement: Progress reporting during download

The extension SHALL display a progress notification during the download and installation.

#### Scenario: Progress shown during download

WHEN download starts
THEN the extension SHALL show a progress notification with title "Downloading pali binary..." and report progress increments.

#### Scenario: Progress dismissed on completion

WHEN download and install complete
THEN the extension SHALL dismiss the progress notification and show the completion message.

### Requirement: Error handling and fallback

The extension SHALL handle download failures gracefully and provide actionable guidance.

#### Scenario: Download failure shows error with manual steps

WHEN download fails (network error, HTTP error, checksum mismatch)
THEN the extension SHALL show an error message with the failure reason and manual install instructions (release URL, architecture, install command).

#### Scenario: Partial download cleaned up

WHEN download fails after partial write
THEN the extension SHALL delete any partially downloaded file at the install path.

#### Scenario: Corrupted binary detected

WHEN installed binary exists but fails to execute
THEN the extension SHALL treat it as missing and re-prompt for download.
