# gdsync

A CLI tool that syncs Google Docs to a local `content.txt` file. AI agents can read and edit documents without touching the Google Docs API directly.

```
gdsync fetch    # pull doc into content.txt
# edit content.txt (or let an AI agent edit it)
gdsync commit   # push changes to Google Docs
```

---

## Quick Start

```bash
npm install -g gdsync
cd /path/to/your/project
gdsync init --doc <documentId>
```

The document ID is the long string in the Google Docs URL:
```
https://docs.google.com/document/d/THIS_IS_THE_ID/edit
```

`gdsync init` handles everything: opens a sign-in URL, fetches the document, and writes `content.txt`. You're ready to edit.

---

## Setup

Run `gdsync setup` to create your own Google Cloud project and authenticate. The CLI opens a guided setup wizard in your browser that walks you through each step.

```bash
gdsync setup
# Open this URL to set up gdsync:
#   https://gdsync-auth.gdsync-dev.workers.dev/setup?session=...

gdsync setup check
# Setup complete. Ready to go.
```

Your documents are accessed through your own GCP project — gdsync never has access to your files.



### Custom OAuth Credentials (Optional)

Power users who want to use their own GCP project can provide credentials via:

**Option A: Environment variables**
```bash
export GOOGLE_CLIENT_ID=your-client-id
export GOOGLE_CLIENT_SECRET=your-client-secret
```

**Option B: Client secret file**
```bash
# Download OAuth client JSON from Google Cloud Console
# Save as ~/.gdsync/client_secret.json
```

When custom credentials are present, gdsync uses the traditional localhost OAuth flow instead of the auth proxy. Run `gdsync dev-setup` for a guided walkthrough of GCP project creation.

---

## Commands

| Command | Description |
|---------|-------------|
| `gdsync init --doc <id>` | First-time setup: auth + fetch in one step |
| `gdsync setup` | Set up GCP project and authenticate |
| `gdsync fetch` | Pull latest doc state into `content.txt` |
| `gdsync commit` | Push edits from `content.txt` to the Google Doc, then verify |
| `gdsync status` | Show document info and pending changes |
| `gdsync reset` | Clear session state and re-fetch from scratch |
| `gdsync config` | View or update settings |
| `gdsync config mode auto\|suggestions` | Switch edit mode |
| `gdsync config comment_filter on\|off` | Toggle @mention comment filtering |
| `gdsync comment list` | Show open comment threads |
| `gdsync comment reply <id> "<msg>"` | Reply to a comment thread |
| `gdsync comment resolve <id>` | Resolve a thread (optionally with `--reply`) |
| `gdsync comment create <blk> "<msg>"` | Create a comment (optionally with `--anchor`) |
| `gdsync dev-setup` | (Optional) GCP project setup for custom credentials |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (missing config, bad input) |
| 2 | Authentication error — run `gdsync setup` |
| 4 | Commit failed (API error or invalid table edit) |
| 5 | Verify failed (document doesn't match after commit) |
| 6 | Image file not found |

---

## Content File Format

After `gdsync fetch`, you get a `content.txt` file like this:

```
---blk_1 paragraph---
# Document Title

---blk_2 paragraph---
This is a paragraph with **bold** and *italic* text.

---blk_3 paragraph---
## Section Heading

---blk_4 list_item---
- List item one

---blk_5 table---
| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |

---blk_6 image---
![alt text](assets/img_001.png)
```

### Blocks

Each block has a delimiter line with an ID and type token:

- `---blk_1 paragraph---` — delimiter with block ID and type
- `---` — bare delimiter for a new block (you write these)
- Type tokens: `paragraph`, `list_item`, `table`, `image`
- Block IDs are session-stable between fetch and commit, but reassigned on each fetch

### Editing Blocks

**Edit** any block's content directly — change text, formatting, heading levels.

**Add** a new block by inserting a bare `---` delimiter:
```
---blk_2 paragraph---
Existing paragraph

---
New paragraph here

---blk_3 paragraph---
Next paragraph
```

**Delete** a block by removing its delimiter line and content entirely.

**Reorder** blocks by moving them to a different position. The sync engine detects moves and applies them in the Google Doc.

### Formatting

Standard markdown inline formatting:

| Syntax | Result |
|--------|--------|
| `**text**` | Bold |
| `*text*` | Italic |
| `***text***` | Bold + italic |
| `` `text` `` | Code (monospace) |
| `[text](url)` | Link |

Heading levels via `#` prefix: `# H1`, `## H2`, `### H3`, up to `###### H6`.

### Lists

Each list item is its own block. Use `- ` for unordered, `1. ` for ordered. Nested lists use 2-space indentation (max 2 levels deep).

### Tables

Tables use markdown table syntax. The entire table is one block. Edit cell content freely. Cannot add/remove rows or columns — do that in Google Docs directly.

Complex tables (merged cells, multi-paragraph cells) are marked `readonly`.

### Images

Images reference local files in the `assets/` folder. The image file **must exist** before you commit. Max 50MB.

### Alignment

Add a style token to the delimiter: `text-left`, `text-center`, `text-right`.

```
---blk_3 paragraph text-center---
This paragraph is centered
```

---

## Comments

`gdsync fetch` writes a `comments.txt` file alongside `content.txt`. This file is **read-only** — it shows open comment threads sorted by position.

```
[#AAAABx3k0Bw | blk_3 | "the specific highlighted text"]
Alice (2026-03-15): @agent Add a citation for this statistic.
  Bob (2026-03-16): Which source do you suggest?
```

### Comment Filtering

When `comment_filter` is on, only comments where you are @mentioned (by name or email) appear in `comments.txt`. This is useful for agents that should only respond to comments directed at them.

```bash
gdsync config comment_filter on    # only @mentioned comments
gdsync config comment_filter off   # all comments (default)
```

The agent's name and email are captured automatically during authentication.

### Acting on Comments

Never edit `comments.txt` directly. Use CLI commands:

```bash
gdsync comment reply AAAABx3k0Bw "Done — added the citation."
gdsync comment resolve AAAABx3k0Bw --reply "Fixed — updated the number."
gdsync comment create blk_5 "This section contradicts section 3."
gdsync comment create blk_5 "Needs a source." --anchor "grew by 40%"
```

---

## Edit Modes

### Auto Mode (default)

Changes are applied directly to the Google Doc.

```bash
gdsync config mode auto
```

### Suggestions Mode

Changes appear as visual suggestions — old text gets ~~strikethrough~~ and new text appears in red below it. Deletions get strikethrough instead of being removed. New blocks are inserted in red.

```bash
gdsync config mode suggestions
```

This lets the document owner review changes before accepting them.

---

## How It Works

Every edit session follows a transactional cycle:

```
1. gdsync fetch   — pulls doc from Google, writes content.txt,
                    creates named ranges as position anchors

2. Edit           — you (or an AI agent) edit content.txt

3. gdsync commit  — diffs against fetched state, builds Google Docs
                    API requests, sends them, re-fetches, verifies
```

Under the hood:
- **Named ranges** track each block's position in the document
- **Block map** in `.gdsync-session` maps block IDs to positions
- Deletions and modifications are processed in reverse document order to avoid index shifting
- Table edits are surgical — only changed cells are updated
- New tables are filled in a second API call after creation
- Inserted text has inherited styles cleared before applying new styles
- Block types are persisted in delimiter tokens to prevent misclassification

---

## Directory Structure

```
your-project/
  .gdsync              ← config file (safe to commit)
  .gdsync-session      ← session state (gitignored)
  .gitignore           ← generated on init
  content.txt          ← the file you edit
  comments.txt         ← read-only: open comment threads
  assets/
    img_001.png        ← downloaded images from the doc
```

Global credentials stored at `~/.gdsync/`:
```
~/.gdsync/
  credentials.json     ← OAuth tokens (never commit)
  client_secret.json   ← optional: custom OAuth credentials

```

---

## Agent Integration

gdsync is designed for AI agents. Ship the `skill.md` file with your agent to give it everything it needs.

### Recommended Setup

1. Create a dedicated Google account for the agent (e.g. `my-agent@gmail.com`)
2. Set up: `gdsync setup` → share the URL → complete the setup wizard
3. Share specific Google Docs with the agent's account
4. Enable comment filtering: `gdsync config comment_filter on`
5. @mention the agent in comments to assign it tasks

The agent only sees documents explicitly shared with it, and only responds to comments where it's @mentioned.

### For Claude Code / Claude Agent SDK

Add `skill.md` to your agent's context (e.g. in `CLAUDE.md`):

```markdown
# Tools
See skill.md for Google Docs editing via gdsync.
```

The agent handles: fetch → read comments → edit content → commit → resolve comments.

---

## Known Limitations

- No adding or removing table rows/columns (edit structure in Google Docs)
- No formatting inside table cells
- No nested tables or merged cells (rendered as readonly)
- Single Google account at a time
- No concurrent sessions on the same document
- Block IDs reassigned on each fetch
- Nested lists max 2 levels deep
- Images in table cells not supported

---

## Troubleshooting

**`Not authenticated`**
> Run `gdsync setup`. If on a remote machine, copy the URL from the terminal output.

**`The caller does not have permission`**
> The authenticated account doesn't have access to this document. Share the doc with the account.

**`Committed but verify failed`**
> Run `gdsync fetch` to pull current state and retry your edits.

**`Image not found at assets/...`**
> The referenced image file doesn't exist. Create it first, then commit.

**`Table row/column count changed`**
> Edit table structure in Google Docs, then `gdsync fetch`.

**Token expired**
> Tokens refresh automatically. If refresh fails, run `gdsync setup` again.

---

## Development

```bash
npm install
npm run build        # compile TypeScript
npm test             # run tests (vitest)
npm run test:watch   # watch mode
npm run dev          # tsc --watch
```

### Architecture

```
src/
  cli.ts              — commander CLI, all commands
  auth.ts             — OAuth: proxy flow + local flow, token refresh
  fetch.ts            — fetch doc, serialize, write content.txt
  serialize.ts        — Google Docs JSON → markdown
  deserialize.ts      — markdown → Google Docs API batchUpdate requests
  commit.ts           — diff content.txt, build + send updates
  verify.ts           — re-fetch and validate after commit
  contentFile.ts      — parse/write content.txt, block diffing, reorder detection
  blockMap.ts         — in-memory block map
  namedRanges.ts      — named range CRUD helpers
  images.ts           — image download (fetch) and upload (commit)
  tables.ts           — table parse, diff, surgical cell updates
  lists.ts            — list detection, prefix handling, nesting
  comments.ts         — comment fetch, format, filter, act via Drive API
  types.ts            — shared TypeScript types
  __tests__/          — 107 unit tests

auth-proxy/           — Cloudflare Workers auth proxy (holds OAuth secret)
  src/index.ts        — router
  src/routes/         — /login, /callback, /api/status, /api/refresh
  src/lib/            — Google OAuth helpers, KV session management
  wrangler.toml       — Workers config
```
