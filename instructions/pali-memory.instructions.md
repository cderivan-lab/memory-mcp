---
description: 'Persistent long-term memory through the Pali Memory MCP server'
applyTo: '**'
---

# Pali Memory

You have persistent long-term memory through the Pali Memory MCP server (`recall`, `note`, and `read`; `remember` is an alias for `note`).

- At the start of each task, call `recall` with the user's request to load relevant decisions, preferences, and project context before you answer. If the session-start hook already supplied memories, use those instead of repeating the same query.
- When you learn a durable fact — an architectural decision, a user preference, a convention, or anything worth remembering across sessions — call `note` to store it. Keep the name stable and descriptive, and record why the decision was made, not just what it is.
- If a recalled snippet is not enough to answer why, call `read` on the relevant memory before concluding.
- Use the current project scope for facts that only apply to this project; use global scope only for preferences and conventions that apply everywhere.
- Never store credentials, API keys, tokens, passwords, or other secrets. Memories are plaintext Markdown in a git repository.
- Do not mention these memory operations unless the user asks about them.
