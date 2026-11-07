# Specification: VS Code Extension MCP Provider Registration

## ADDED Requirements

### Requirement: REQ-431 Provider Registration

- **ID**: REQ-431
- **Description**: Extension calls `vscode.lm.registerMcpServerDefinitionProvider("pali", provider)` on activate
- **Rationale**: Automatic server registration

#### Scenario: Provider registration

- **WHEN** the extension is activated
- **THEN** it calls `vscode.lm.registerMcpServerDefinitionProvider("pali", provider)`

### Requirement: REQ-432 Server Definition

- **ID**: REQ-432
- **Description**: Provider returns `McpStdioServerDefinition` with command/args/env from `pali.*` settings
- **Rationale**: Configurable server launch

#### Scenario: Server definition

- **WHEN** the provider returns a definition
- **THEN** it is a `McpStdioServerDefinition` with command/args/env

### Requirement: REQ-433 Settings Integration

- **ID**: REQ-433
- **Description**: Uses `pali.command`, `pali.args`, `pali.env` settings
- **Rationale**: User customization

#### Scenario: Settings integration

- **WHEN** settings are configured
- **THEN** `pali.command`, `pali.args`, `pali.env` are used

### Requirement: REQ-434 Package.json Contribution

- **ID**: REQ-434
- **Description**: `package.json` contributes `mcpServerDefinitionProviders` with `pali`
- **Rationale**: VS Code discovers provider

#### Scenario: Package.json contribution

- **WHEN** package.json is reviewed
- **THEN** it contributes `mcpServerDefinitionProviders` with `pali`

### Requirement: REQ-435 Tests

- **ID**: REQ-435
- **Description**: Integration tests verify provider registration and definition
- **Rationale**: Regression prevention

#### Scenario: Tests verification

- **WHEN** tests are run
- **THEN** provider registration and definition are verified

### Requirement: REQ-436 Backward Compatibility

- **ID**: REQ-436
- **Description**: VS Code < 1.101 logs warning, no registration (graceful degradation)
- **Rationale**: Older VS Code versions still work

#### Scenario: Backward compatibility

- **WHEN** VS Code version is < 1.101
- **THEN** a warning is logged and no registration occurs
| `pali.env` | object | {} | Environment variables |

## Files

| File | Purpose |
| ------ | --------- |
| `extension.js` | Activates, registers provider |
| `lib.js` | Exports `mcpServerDefinition` object |
| `package.json` | Contributes `mcpServerDefinitionProviders` |
| `test/extension.test.js` | Provider registration tests |
| `test/vsix.test.js` | Packaging tests |

## Acceptance Criteria

- [ ] `extension.js` calls `vscode.lm.registerMcpServerDefinitionProvider`
- [ ] Provider returns `McpStdioServerDefinition`
- [ ] Server definition uses `pali.command`, `pali.args`, `pali.env`
- [ ] `package.json` has `mcpServerDefinitionProviders` contribution
- [ ] Tests pass: provider registration, definition shape
- [ ] VS Code 1.101+ shows pali in MCP servers list
- [ ] VS Code < 1.101 logs warning, no crash
