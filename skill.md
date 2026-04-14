# gdsync — Agent Skill

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
- Don't change type tokens or assign block IDs
- Tables: edit cells only, no row/column changes. Don't edit `readonly` blocks.
- Images: file must exist in `assets/` before commit

## Comments

`comments.txt` is read-only. Use CLI commands:

```bash
gdsync comment reply <threadId> "<message>"
gdsync comment create <blockId> "<message>" --anchor "<text>"
```

**Always reply, never resolve** — the user reviews and resolves in Google Docs.

## Settings

```bash
gdsync config mode suggestions   # strikethrough + red visual suggestions
gdsync config mode auto          # direct edits (default)
gdsync config comment_filter on  # only show @mentioned comments
```

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
