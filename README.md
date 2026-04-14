# gdsync

A CLI tool that lets AI agents read and edit Google Docs. The agent works with a simple local file — the sync engine handles all the Google Docs API complexity.

Your documents are accessed through your own GCP project — gdsync never has access to your files.

## Install

**Add to your AI agent (Claude Code, etc.):**

> [**Download gdsync-skill.zip**](https://github.com/kylecooper7/gdsync/releases/latest/download/gdsync-skill.zip) — add this skill package to your agent

**Install the CLI:**

```bash
npm install -g @gdsync/gdsync
```

---

## How It Works

```
gdsync fetch    # pull Google Doc into content.txt
# agent edits content.txt
gdsync commit   # push changes to the live Google Doc
```

The agent sees a clean markdown-like file. The user sees their Google Doc update in real time.

---

## Quick Start

### 1. Set up your GCP project

```bash
gdsync setup          # opens a guided wizard in your browser
gdsync setup check    # confirm setup is complete
```

The wizard creates a Google Cloud project for you and walks you through configuring OAuth. If you already have a project from a previous setup, the wizard lets you reuse it.

For manual setup: `gdsync setup manual` opens a step-by-step guide.

### 2. Authenticate

```bash
gdsync auth           # prints a sign-in URL
gdsync auth check     # confirm sign-in
```

We recommend signing in with a dedicated agent account (e.g. `my-agent@gmail.com`) rather than your personal account. The agent can only access documents shared with this account.

### 3. Find and open a doc

```bash
gdsync docs                     # list accessible Google Docs
gdsync docs --search "keyword"  # search by name
gdsync init --doc <documentId>  # start editing
```

The document ID is in the URL: `https://docs.google.com/document/d/THIS_IS_THE_ID/edit`

---

## Commands

| Command | Description |
|---|---|
| `gdsync setup` | Set up GCP project (guided wizard) |
| `gdsync setup manual` | Manual GCP project setup (step-by-step guide) |
| `gdsync setup check` | Check if setup is complete |
| `gdsync auth` | Authenticate for document access |
| `gdsync auth check` | Check if authentication is complete |
| `gdsync docs` | List accessible Google Docs |
| `gdsync docs --search "x"` | Search docs by name |
| `gdsync init --doc <id>` | Initialize sync for a document |
| `gdsync fetch` | Pull latest doc into content.txt |
| `gdsync commit` | Push content.txt edits to Google Doc |
| `gdsync status` | Show current sync state |
| `gdsync reset` | Clear session and re-fetch |
| `gdsync config` | View or change settings |
| `gdsync comment reply <id> "msg"` | Reply to a comment |
| `gdsync comment resolve <id>` | Resolve a comment |
| `gdsync comment create <blk> "msg"` | Create a comment |

---

## Content File Format

After `gdsync fetch`, you get a `content.txt` file:

```
---blk_1 paragraph---
# Document Title

---blk_2 paragraph---
This is a paragraph with **bold** and *italic* text.

---blk_3 list_item---
- List item one

---blk_4 table---
| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |

---blk_5 image---
![alt text](assets/img_001.png)
```

- **Edit** any block's content directly
- **Add** a new block: insert a bare `---` delimiter (no ID)
- **Delete** a block: remove its delimiter and content
- **Reorder** blocks: move them to a different position
- Formatting: `**bold**`, `*italic*`, `` `code` ``, `[link](url)`, `# Heading`
- Tables: edit cell content only (no row/column changes)
- Images: file must exist in `assets/` before commit

---

## Comments

`comments.txt` shows open comment threads (read-only). Use CLI commands to act on them:

```bash
gdsync comment reply AAAABx3k0Bw "Done — added the citation."
gdsync comment create blk_5 "Needs a source." --anchor "grew by 40%"
gdsync comment resolve AAAABx3k0Bw --reply "Fixed."
```

Filter to @mentioned comments only: `gdsync config comment_filter on`

---

## Edit Modes

**Auto** (default) — changes applied directly to the Google Doc.

**Suggestions** — changes appear as visual suggestions (strikethrough + red text). The document owner reviews and accepts/rejects.

```bash
gdsync config mode suggestions
gdsync config mode auto
```

---

## Agent Integration

gdsync is built for AI agents. The skill file teaches an agent the full workflow.

**Recommended setup:**
1. Create a dedicated Google account for the agent
2. Run `gdsync setup` to create the GCP project
3. Run `gdsync auth` to authenticate
4. Share specific Google Docs with the agent's account
5. Enable comment filtering: `gdsync config comment_filter on`
6. @mention the agent in comments to assign tasks

---

## Development

```bash
npm install
npm run build        # compile TypeScript
npm test             # run 107 unit tests
npm run dev          # tsc --watch
```

---

## Links

- [Homepage](https://kylecooper7.github.io/gdsync/)
- [Privacy Policy](https://kylecooper7.github.io/gdsync/privacy.html)
- [Terms of Service](https://kylecooper7.github.io/gdsync/terms.html)

## License

MIT
