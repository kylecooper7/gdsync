---
name: Google Docs Editor
description: Read, edit, and comment on Google Docs via a local content file. Use when asked to work with Google Docs, address doc comments, or make document edits.
dependencies: "@gdsync/gdsync"
---

# gdsync — Google Docs Editor

Edit Google Docs through a local `content.txt` file. Fetch, edit, commit — changes appear in the live doc. The local file format (blocks, delimiters, markdown) is agent-internal only. Never mention these to the user — they work with the Google Doc directly.

## Setup

```bash
npm install -g @gdsync/gdsync   # if not installed
```

### 1. GCP Project

Run `gdsync setup` — prints a wizard URL, exits. Share with user:

> "Open this link to set up gdsync. Sign in with a dedicated agent Google account (e.g. my-agent@gmail.com), not your personal account. The agent can only access docs shared with this account."

Then `gdsync setup check` (exit 0 = done, 1 = retry, 2 = expired — run `gdsync setup` again).

Already have a project? `gdsync setup manual` opens a guide to reuse it.

### 2. Authenticate

Run `gdsync auth` — prints sign-in URL, exits. Tell user: "Sign in with the agent's Google account." Then `gdsync auth check` (same exit codes).

### 3. Open a Document

```bash
gdsync docs                     # list accessible docs
gdsync docs --search "keyword"  # search by name
gdsync init --doc <documentId>  # initialize sync
```

If the doc isn't listed, user must share it with the agent's account.

## Editing Workflow

Always follow this order:

1. `gdsync fetch` — pull latest doc state (always do this first)
2. Read `content.txt` (document) and `comments.txt` (feedback)
3. Edit `content.txt`
4. `gdsync commit` — push changes, verify. Never leave edits uncommitted.

## Content File Format

Each paragraph, list item, table, or image is a block:

```
---blk_1 paragraph---
# Heading

---blk_2 paragraph---
Text with **bold**, *italic*, `code`, [link](url).

---blk_3 list_item---
- Item (use 1. for ordered, 2-space indent for nesting)

---blk_4 table---
| H1 | H2 |
| -- | -- |
| C1 | C2 |

---blk_5 image---
![alt](assets/img_001.png)
```

- **Add:** insert bare `---` (no ID) where you want new content
- **Delete:** remove delimiter + content
- **Reorder:** move delimiter + content to new position
- **Spacing:** insert an empty `---` block (a blank line) to add vertical space between sections
- Don't change type tokens or assign block IDs
- Tables: edit cell text (with `**bold**`/`*italic*`/`` `code` ``/`[link](url)` inside cells), and add or remove rows/columns by editing the markdown grid. Escape a literal pipe in a cell as `\|`. Don't edit `readonly` blocks (complex tables).
- Images: reference a local file in `assets/` (must exist before commit) or a public URL, e.g. `![alt](https://example.com/img.png)`. Center or right-align with a `text-center` / `text-right` token, e.g. `--- text-center---`.

## Comments

`comments.txt` is read-only. Use CLI commands:

```bash
gdsync comment reply <threadId> "<message>"
gdsync comment create <blockId> "<message>" --anchor "<text>"
```

**Always reply, never resolve** — the user reviews and resolves in Google Docs.

## Settings

```bash
gdsync config mode suggestions   # propose changes as a visual review (see below)
gdsync config mode auto          # direct edits (default)
gdsync config comment_filter on  # only show @mentioned comments
```

### Suggestions mode

The Google Docs API can't create native suggestions, so gdsync simulates them: on commit, **old/removed text is struck through and new text is shown in red** as a review preview for the human — it is NOT native Google Docs "Suggesting" mode (no Accept/Reject buttons).

Important for editing: after a suggestions commit, a re-fetch shows **both** versions. The struck-through old text appears wrapped in `~~...~~`, and the new text sits in a separate block. The human accepts a change by **deleting the `~~struck~~` block**, or rejects it by deleting the new text. Don't be confused by the duplicated content — that's the review preview. Prefer auto mode unless the user explicitly wants to review changes before they apply.

## Rules

1. Always fetch before editing
2. Always commit after editing
3. Never edit readonly blocks
4. Never assign block IDs — use bare `---`
5. One fetch-edit-commit cycle at a time
6. Never edit comments.txt — use CLI commands
7. Reply to comments, never resolve
8. Never expose blocks, delimiters, or content.txt to the user

## Error Recovery

| Problem | Fix |
|---|---|
| Commit fails | Read error, fix, `gdsync commit` |
| Content wrong | `gdsync fetch` to reset |
| Crashed | `gdsync reset` then `gdsync fetch` |
| Not set up | `gdsync setup` → `gdsync setup check` |
| Not authenticated | `gdsync auth` → `gdsync auth check` |
| Doc not listed | User must share with agent's account |
