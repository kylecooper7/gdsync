/**
 * comments.ts — Fetch, format, and act on Google Doc comments.
 *
 * comments.txt is read-only for agents. All actions (reply, resolve, create)
 * go through CLI commands that call this module, which hits the Drive API
 * and rewrites comments.txt.
 */

import * as fs from "fs";
import * as path from "path";
import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { BlockMap, BlockMapEntry } from "./types.js";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type CommentThread = {
  threadId: string;
  blockId: string | null; // null if unanchored
  highlightedText: string;
  anchorOffset: number | null; // character offset in doc, for sorting
  resolved: boolean;
  rootComment: CommentEntry;
  replies: CommentEntry[];
};

export type CommentEntry = {
  author: string;
  date: string; // YYYY-MM-DD
  content: string;
};

// -------------------------------------------------------------------------
// Fetch comments from Drive API
// -------------------------------------------------------------------------

function getDriveClient(auth: OAuth2Client): drive_v3.Drive {
  return google.drive({ version: "v3", auth });
}

/**
 * Fetch all comment threads from the Google Doc via the Drive API.
 * Maps each thread to a block ID using the block map.
 */
export async function fetchComments(
  auth: OAuth2Client,
  fileId: string,
  blockMap: BlockMap,
  includeResolved: boolean = false,
  mentionFilter?: { email: string; name: string }
): Promise<CommentThread[]> {
  const drive = getDriveClient(auth);

  const threads: CommentThread[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.comments.list({
      fileId,
      fields: "comments(id,content,htmlContent,author,createdTime,resolved,quotedFileContent,anchor,replies(id,content,htmlContent,author,createdTime)),nextPageToken",
      includeDeleted: false,
      pageSize: 100,
      pageToken,
    });

    const comments = response.data.comments ?? [];

    for (const comment of comments) {
      if (!includeResolved && comment.resolved) continue;

      // If mention filter is active, skip threads where the user isn't @mentioned
      if (mentionFilter) {
        const allHtml = [
          (comment as any).htmlContent ?? "",
          ...((comment.replies ?? []).map((r: any) => r.htmlContent ?? "")),
        ].join(" ");
        const allContent = [
          comment.content ?? "",
          ...((comment.replies ?? []).map((r) => r.content ?? "")),
        ].join(" ");

        const mentioned = isMentioned(allHtml, allContent, mentionFilter);
        if (!mentioned) continue;
      }

      const threadId = comment.id ?? "";
      const highlightedText = comment.quotedFileContent?.value ?? "";
      const anchorOffset = parseAnchorOffset(comment.anchor);
      const blockId = mapToBlockId(anchorOffset, blockMap);

      const rootComment: CommentEntry = {
        author: comment.author?.displayName ?? "Unknown",
        date: formatDate(comment.createdTime),
        content: comment.content ?? "",
      };

      const replies: CommentEntry[] = (comment.replies ?? []).map((reply) => ({
        author: reply.author?.displayName ?? "Unknown",
        date: formatDate(reply.createdTime),
        content: reply.content ?? "",
      }));

      threads.push({
        threadId,
        blockId,
        highlightedText,
        anchorOffset,
        resolved: comment.resolved ?? false,
        rootComment,
        replies,
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Sort by document position
  threads.sort((a, b) => (a.anchorOffset ?? Infinity) - (b.anchorOffset ?? Infinity));

  return threads;
}

/**
 * Check if the user is @mentioned in a comment thread.
 * Google Docs @mentions appear in htmlContent as mailto links or +email,
 * and in plain content as +email or the user's name.
 */
function isMentioned(
  htmlContent: string,
  plainContent: string,
  user: { email: string; name: string }
): boolean {
  const lower = (htmlContent + " " + plainContent).toLowerCase();
  if (user.email && lower.includes(user.email.toLowerCase())) return true;
  if (user.name && lower.includes(user.name.toLowerCase())) return true;
  return false;
}

/**
 * Parse the anchor JSON to extract the character offset.
 * Google Docs anchor format: {"r":0,"a":[{"txt":{"o":<offset>,"l":<length>}}]}
 */
function parseAnchorOffset(anchor: string | null | undefined): number | null {
  if (!anchor) return null;
  try {
    const parsed = JSON.parse(anchor);
    const txt = parsed?.a?.[0]?.txt;
    if (txt && typeof txt.o === "number") {
      return txt.o;
    }
  } catch {
    // Anchor format may vary — not fatal
  }
  return null;
}

/**
 * Map a character offset to a block ID using the block map.
 */
function mapToBlockId(offset: number | null, blockMap: BlockMap): string | null {
  if (offset === null) return null;

  const entries = Array.from(blockMap.values()).sort(
    (a, b) => a.startIndex - b.startIndex
  );

  for (const entry of entries) {
    if (offset >= entry.startIndex && offset < entry.endIndex) {
      return entry.blockId;
    }
  }

  // If offset is past the last block, assign to the last block
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    if (offset >= last.startIndex) {
      return last.blockId;
    }
  }

  return null;
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "unknown";
  const d = new Date(dateStr);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// -------------------------------------------------------------------------
// Write comments.txt
// -------------------------------------------------------------------------

/**
 * Format comment threads into the comments.txt file format and write to disk.
 */
export function writeCommentsFile(
  workDir: string,
  threads: CommentThread[]
): void {
  const filePath = path.join(workDir, "comments.txt");
  const content = formatCommentsFile(threads);
  fs.writeFileSync(filePath, content, "utf-8");
}

export function formatCommentsFile(threads: CommentThread[]): string {
  if (threads.length === 0) {
    return "No open comments.\n";
  }

  const sections: string[] = [];

  for (const thread of threads) {
    const lines: string[] = [];

    // Header line
    const blockPart = thread.blockId ?? "unanchored";
    const textPart = truncateHighlight(thread.highlightedText);
    const resolvedPrefix = thread.resolved ? "[resolved] " : "";
    lines.push(`${resolvedPrefix}[#${thread.threadId} | ${blockPart} | "${textPart}"]`);

    // Root comment
    lines.push(formatCommentLine(thread.rootComment, ""));

    // Replies
    for (const reply of thread.replies) {
      lines.push(formatCommentLine(reply, "  "));
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n") + "\n";
}

function truncateHighlight(text: string): string {
  if (text.length <= 120) return text;
  return text.slice(0, 117) + "...";
}

function formatCommentLine(entry: CommentEntry, indent: string): string {
  const firstLine = `${indent}${entry.author} (${entry.date}): ${entry.content}`;

  // For multi-line comments, indent continuation lines
  const lines = firstLine.split("\n");
  if (lines.length === 1) return firstLine;

  const continuationIndent = indent + "  ";
  return lines
    .map((line, i) => (i === 0 ? line : continuationIndent + line))
    .join("\n");
}

// -------------------------------------------------------------------------
// Comment actions (reply, resolve, create)
// -------------------------------------------------------------------------

/**
 * Reply to an existing comment thread.
 */
export async function replyToComment(
  auth: OAuth2Client,
  fileId: string,
  threadId: string,
  message: string
): Promise<void> {
  const drive = getDriveClient(auth);
  await drive.replies.create({
    fileId,
    commentId: threadId,
    fields: "id",
    requestBody: {
      content: message,
    },
  });
}

/**
 * Resolve a comment thread. Optionally post a reply first.
 */
export async function resolveComment(
  auth: OAuth2Client,
  fileId: string,
  threadId: string,
  replyMessage?: string
): Promise<void> {
  const drive = getDriveClient(auth);

  // The Drive API resolves a comment by creating a reply with action "resolve"
  await drive.replies.create({
    fileId,
    commentId: threadId,
    fields: "id",
    requestBody: {
      content: replyMessage ?? "Resolved",
      action: "resolve",
    },
  });
}

/**
 * Create a new comment on the document.
 * If anchorText is provided, anchors to that specific text within the block.
 * Otherwise anchors to the first line of the block's content.
 *
 * For Google Docs, the Drive API anchors comments via quotedFileContent
 * (with mimeType text/plain). The JSON anchor format doesn't work for Docs.
 */
export async function createComment(
  auth: OAuth2Client,
  fileId: string,
  blockId: string,
  message: string,
  blockMap: BlockMap,
  anchorText?: string
): Promise<void> {
  const drive = getDriveClient(auth);

  const entry = blockMap.get(blockId);
  if (!entry) {
    throw new Error(`Block ${blockId} not found in block map. Run gdsync fetch first.`);
  }

  // Google Docs does not support anchored comments via the Drive API
  // (confirmed platform limitation). We set quotedFileContent so the
  // comment shows the referenced text in a dropdown for context.
  const requestBody: drive_v3.Schema$Comment = {
    content: message,
    quotedFileContent: {
      value: anchorText || `[${blockId}]`,
      mimeType: "text/html",
    },
  };

  await drive.comments.create({
    fileId,
    fields: "id",
    requestBody,
  });
}

/**
 * Convenience: fetch comments and rewrite comments.txt.
 * Used after every action to keep the file in sync.
 */
export async function refreshCommentsFile(
  auth: OAuth2Client,
  fileId: string,
  workDir: string,
  blockMap: BlockMap,
  includeResolved: boolean = false,
  mentionFilter?: { email: string; name: string }
): Promise<CommentThread[]> {
  const threads = await fetchComments(auth, fileId, blockMap, includeResolved, mentionFilter);
  writeCommentsFile(workDir, threads);
  return threads;
}
