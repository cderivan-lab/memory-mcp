# Spec Delta

## Purpose

The `pali` VS Code extension registers the `pali` MCP server with the editor on
activation, so enabling the extension is sufficient to start the server — no
install link, no command-palette action, no manual configuration.

## ADDED Requirements

### Requirement: MCP server SHALL be registered through a definition provider

The extension SHALL call `vscode.lm.registerMcpServerDefinitionProvider("pali", ...)`,
so the editor starts the `pali` process itself.

#### Scenario: provider registers on activation

- **WHEN** the extension activates in VS Code 1.101 or newer
- **THEN** `registerMcpServerDefinitionProvider` is called with the id `pali`

#### Scenario: provider returns the configured stdio server

- **WHEN** `pali.binPath`, `pali.repoPath`, `pali.remoteUrl`, and `pali.branch`
  are all set
- **THEN** the provider returns an `McpStdioServerDefinition` whose `command` is
  `pali.binPath`, whose `args` include `serve` plus the configured repo and
  remote, and whose `env` includes `PALI_BRANCH=<branch>`

#### Scenario: optional settings are empty

- **WHEN** `pali.repoPath` and `pali.remoteUrl` are empty strings
- **THEN** the returned definition omits the corresponding args and env entries
  rather than passing empty values

#### Scenario: older VS Code build

- **WHEN** `vscode.lm.registerMcpServerDefinitionProvider` is not a function
- **THEN** the extension logs that the build lacks the API and registers no
  server, rather than throwing

#### Scenario: settings change

- **WHEN** a `pali.*` setting changes after activation
- **THEN** the provider's `onDidChangeMcpServerDefinitions` event fires so the
  editor re-asks for the definition

## MODIFIED Requirements

(none)