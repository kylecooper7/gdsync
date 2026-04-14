# gdsync

A CLI tool that lets AI agents read and edit Google Docs through a simple local file. The agent edits `content.txt`, runs a command, and changes appear in the live document.

## How It Works

```
gdsync fetch   →  edit content.txt  →  gdsync commit
```

The sync engine handles all the complexity — Google Docs API, formatting, character indexes, named ranges, images, tables, lists. The agent just sees clean markdown.

## Install

```bash
npm install -g @gdsync/gdsync
```

Requires Node.js 18+.

## Quick Start

```bash
# 1. Authenticate
gdsync auth
# → prints a sign-in URL, share it with the user
gdsync auth check
# → "Authentication successful."

# 2. List available docs
gdsync docs

# 3. Open a doc
gdsync init --doc <documentId>

# 4. Edit and push
gdsync fetch
# edit content.txt
gdsync commit
```

## Claude Code Skill

To add gdsync as a skill for Claude Code agents, download and install the skill package:

[**Download gdsync-skill.zip**](https://github.com/kylecooper7/gdsync/raw/main/gdsync-skill.zip)

The skill teaches agents the full workflow: authentication, fetching docs, editing content, committing changes, and managing comments.

## What the Agent Sees

```
---blk_1 paragraph---
# Document Title

---blk_2 paragraph---
This is a paragraph with **bold** and *italic* text.

---blk_3 list_item---
- A list item

---blk_4 table---
| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |
```

## Features

- **Two-step non-blocking auth** — agent-friendly, no background processes
- **Block-based format** — each paragraph, list item, table, or image is a block
- **Inline markdown** — bold, italic, code, links, headings
- **Lists** — ordered, unordered, nested (up to 2 levels)
- **Tables** — edit cell content via markdown table syntax
- **Images** — download on fetch, upload on commit
- **Comments** — read, reply, resolve, and create comment threads
- **Suggestions mode** — visual tracked changes (strikethrough + red text)
- **Doc listing** — browse accessible docs including shared files

## Commands

| Command | What it does |
|---|---|
| `gdsync auth` | Start authentication (prints URL, exits) |
| `gdsync auth check` | Check if auth is complete |
| `gdsync docs` | List accessible Google Docs |
| `gdsync docs --search "x"` | Search docs by name |
| `gdsync init --doc <id>` | Initialize sync for a document |
| `gdsync fetch` | Pull latest doc into content.txt |
| `gdsync commit` | Push content.txt edits to Google Doc |
| `gdsync status` | Show sync session state |
| `gdsync reset` | Wipe session, re-fetch clean |
| `gdsync config` | View/change settings |
| `gdsync comment reply <id> "msg"` | Reply to a comment |
| `gdsync comment resolve <id>` | Resolve a comment |
| `gdsync comment create <blk> "msg"` | Create a new comment |

## Own GCP Project (Optional)

By default, gdsync uses a shared Google Cloud project. For dedicated rate limits, you can set up your own:

```bash
gdsync setup auto          # guided web wizard
gdsync setup check         # confirm credentials saved
gdsync auth                # authenticate with your project
```

Or manually provide credentials via environment variables:

```bash
export GOOGLE_CLIENT_ID=your-client-id
export GOOGLE_CLIENT_SECRET=your-client-secret
gdsync setup manual        # confirm detected
gdsync auth
```

## License

MIT
