---
name: openspec-create-detailed-design
description: Generate a detailed technical design document for an OpenSpec change (design only).
---
$ARGUMENTS
<!-- OPENSPEC:START -->
**Guardrails**
- Do NOT output the Markdown content in the chat. Instead, use the file creation tool to create `openspec/changes/<change-id>/detailed-design.md`.
- After creating the file, inform the user that the file has been created at `openspec/changes/<change-id>/detailed-design.md` for review.
- Design only: do NOT implement code.
- Keep the design specific and actionable; avoid vague statements.
- When you mention file paths, prefix them with the actual repository name if you have clear evidence from the workspace/context. If ambiguous or no evidence exists, use `<RepositoryName>` as a placeholder. Never mix both styles in the same document.
- Do the reasoning internally; do NOT output chain-of-thought.

**Steps**
1. **Analysis Phase**: Read the provided change inputs (`proposal.md`, `tasks.md`, optional `design.md`, and any delta specs under `openspec/changes/<change-id>/specs/**/spec.md`). Explore the existing codebase to understand current behavior and identify impact areas.

2. **Creation Phase**: Produce a comprehensive `detailed-design.md` file that clearly states the problem and chosen approach, lists **In Scope** and **Out of Scope**, includes Mermaid diagrams when needed, provides implementation details grouped by file path, covers migration strategy, and includes a verification plan.

3. **Verification Phase**: Self-check: Does the design satisfy `proposal.md` and align with `tasks.md`? Are all file paths specific and prefixed appropriately? Are Mermaid diagrams valid? Are code snippets syntactically correct with necessary imports? Note completion and ask the user to review the file.

**Steps**
1. Read the provided change inputs: `proposal.md`, `tasks.md`, optional `design.md`, and any delta specs under `openspec/changes/<change-id>/specs/**/spec.md`.
2. Explore the existing codebase (search + read relevant source files) to understand current behavior and identify impact areas:
   - Entry points, data models, existing flows, and adjacent features
   - Dependencies, shared utilities, and potential breaking changes
3. Produce a comprehensive `detailed-design.md` that:
   - Clearly states the problem and the chosen approach
   - Explicitly lists **In Scope** and **Out of Scope**
   - Includes Mermaid diagrams when multiple components/flows are involved
   - Provides implementation details grouped by file path (`<RepositoryName>/...`) with concrete code snippets (including imports) for complex logic / new types / schemas
   - Covers migration strategy (or explicitly states “No migration required” with rationale)
   - Includes a verification plan with concrete test scenarios
4. Self-check before finishing:
   - Does the design satisfy `proposal.md` and align with `tasks.md`?
   - Are all file paths specific and prefixed with `<RepositoryName>/`?
   - Are Mermaid diagrams valid?
   - Are code snippets syntactically correct and include necessary imports?

**Output Format (`detailed-design.md`)**
### 1. Overview
Briefly summarize the technical approach.

### 2. Scope & Constraints
- **In Scope**: bullet list of concrete items.
- **Out of Scope**: bullet list (must be present).
- **Constraints**: compatibility, performance, security, rollout, etc.

### 3. Architecture & Diagrams
- Include Mermaid diagrams (Sequence / Component / Activity) when the change spans multiple components.
- Wrap diagrams in `mermaid` code blocks.

### 4. Implementation Details (by File Path)
For each affected file (use `<RepositoryName>/path/to/file`):
- **Purpose**
- **Changes**
- **Code Snippets** (mandatory for new schemas/types/complex logic; include imports)
- Error handling and edge cases
- Backward-compatibility considerations (if relevant)

### 5. Migration Strategy
- If any schema/state/data changes exist: describe migration steps, backfill/defaulting, rollback.
- Otherwise: explicitly state “No migration required” and why.

### 6. Verification Plan
- Unit test scenarios
- Integration/e2e scenarios (if applicable)
- Manual verification steps (if needed)
- Failure modes and edge cases to test

### 7. Open Questions (if any)
List unresolved items that must be clarified before implementation.

<!-- OPENSPEC:END -->
