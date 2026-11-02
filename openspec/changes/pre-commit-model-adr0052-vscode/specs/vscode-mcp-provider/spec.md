# Specification: VS Code Extension MCP Provider Registration

## Scope

VS Code extension registers pali MCP server via VS Code 1.101+ MCP API.

## Requirements

### REQ-431: Provider Registration

- **ID**: REQ-431
- **Description**: Extension calls `vscode.lm.registerMcpServerDefinitionProvider("pali", provider)` on activate
- **Rationale**: Automatic server registration

### REQ-432: Server Definition

- **ID**: REQ-432
- **Description**: Provider returns `McpStdioServerDefinition` with command/args/env from `pali.*` settings
- **Rationale**: Configurable server launch

### REQ-433: Settings Integration

- **ID**: REQ-433
- **Description**: Uses `pali.command`, `pali.args`, `pali.env` settings
- **Rationale**: User customization

### REQ-434: Package.json Contribution

- **ID**: REQ-434
- **Description**: `package.json` contributes `mcpServerDefinitionProviders` with `pali`
- **Rationale**: VS Code discovers provider

### REQ-435: Tests

- **ID**: REQ-435
- **Description**: Integration tests verify provider registration and definition
- **Rationale**: Regression prevention

### REQ-436: Backward Compatibility

- **ID**: REQ-436
- **Description**: VS Code < 1.101 logs warning, no registration (graceful degradation)
- **Rationale**: Older VS Code versions still work

## Settings

| Setting | Type | Default | Description |
| --------- | ------ | --------- | ------------- |
| `pali.command` | string | "pali" | CLI command |
| `pali.args` | string[] | ["serve"] | CLI arguments |
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
