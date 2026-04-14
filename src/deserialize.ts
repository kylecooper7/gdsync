/**
 * deserialize.ts — Converts a markdown block into Google Docs API batchUpdate requests.
 * This runs during commit.
 */

import { docs_v1 } from "googleapis";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Text, Strong, Emphasis, InlineCode, Link } from "mdast";
import { parseListPrefix, stripListPrefix, addNestingTabs } from "./lists.js";
import { Block, BlockMapEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Inline markdown parsing
// ---------------------------------------------------------------------------

type StyleSpan = {
  startOffset: number; // offset in plain text
  endOffset: number;
  bold: boolean;
  italic: boolean;
  code: boolean;
  linkUrl: string | null;
};

/**
 * Parse a markdown string into a plain text + style spans.
 * Uses remark to build an AST, then walks it.
 */
export function parseInlineMarkdown(markdown: string): {
  plainText: string;
  spans: StyleSpan[];
} {
  // Parse as a single paragraph
  const processor = unified().use(remarkParse);
  const tree = processor.parse(markdown) as Root;

  let plainText = "";
  const spans: StyleSpan[] = [];

  function walk(
    node: import("mdast").Node,
    bold: boolean,
    italic: boolean,
    code: boolean,
    linkUrl: string | null
  ): void {
    if (node.type === "text") {
      const textNode = node as Text;
      const start = plainText.length;
      plainText += textNode.value;
      const end = plainText.length;
      if (bold || italic || code || linkUrl) {
        spans.push({ startOffset: start, endOffset: end, bold, italic, code, linkUrl });
      }
    } else if (node.type === "strong") {
      const n = node as Strong;
      for (const child of n.children) {
        walk(child, true, italic, code, linkUrl);
      }
    } else if (node.type === "emphasis") {
      const n = node as Emphasis;
      for (const child of n.children) {
        walk(child, bold, true, code, linkUrl);
      }
    } else if (node.type === "inlineCode") {
      const n = node as InlineCode;
      const start = plainText.length;
      plainText += n.value;
      const end = plainText.length;
      spans.push({ startOffset: start, endOffset: end, bold, italic, code: true, linkUrl });
    } else if (node.type === "link") {
      const n = node as Link;
      for (const child of n.children) {
        walk(child, bold, italic, code, n.url);
      }
    } else if ("children" in node) {
      const parent = node as { children: import("mdast").Node[] };
      for (const child of parent.children) {
        walk(child, bold, italic, code, linkUrl);
      }
    }
  }

  // Walk the root, diving into the first paragraph
  const firstPara = (tree.children ?? []).find((n) => n.type === "paragraph");
  if (firstPara && "children" in firstPara) {
    for (const child of (firstPara as { children: import("mdast").Node[] }).children) {
      walk(child, false, false, false, null);
    }
  } else {
    // Fallback: treat as raw text
    plainText = markdown;
  }

  return { plainText, spans };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export function namedStyleType(content: string): string {
  if (content.startsWith("###### ")) return "HEADING_6";
  if (content.startsWith("##### ")) return "HEADING_5";
  if (content.startsWith("#### ")) return "HEADING_4";
  if (content.startsWith("### ")) return "HEADING_3";
  if (content.startsWith("## ")) return "HEADING_2";
  if (content.startsWith("# ")) return "HEADING_1";
  return "NORMAL_TEXT";
}

function stripHeadingPrefix(content: string): string {
  return content.replace(/^#{1,6} /, "");
}

function alignmentValue(token: string): string | null {
  switch (token) {
    case "text-left":
      return "START";
    case "text-center":
      return "CENTER";
    case "text-right":
      return "END";
    default:
      return null;
  }
}

/**
 * Emit updateTextStyle requests for all styled spans.
 * docStartIndex is the paragraph's start position in the document.
 */
function buildTextStyleRequests(
  spans: StyleSpan[],
  docStartIndex: number
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [];

  for (const span of spans) {
    const rangeStart = docStartIndex + span.startOffset;
    const rangeEnd = docStartIndex + span.endOffset;
    const range = { startIndex: rangeStart, endIndex: rangeEnd };

    if (span.bold && span.italic) {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: { bold: true, italic: true },
          fields: "bold,italic",
        },
      });
    } else if (span.bold) {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: { bold: true },
          fields: "bold",
        },
      });
    } else if (span.italic) {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: { italic: true },
          fields: "italic",
        },
      });
    }

    if (span.code) {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: { weightedFontFamily: { fontFamily: "Courier New" } },
          fields: "weightedFontFamily",
        },
      });
    }

    if (span.linkUrl) {
      requests.push({
        updateTextStyle: {
          range,
          textStyle: { link: { url: span.linkUrl } },
          fields: "link",
        },
      });
    }
  }

  return requests;
}

// ---------------------------------------------------------------------------
// Main deserialization functions
// ---------------------------------------------------------------------------

/**
 * Build requests to delete a block from the document.
 * Must be processed in reverse document order.
 */
export function buildDeleteRequests(entry: BlockMapEntry): docs_v1.Schema$Request[] {
  return [
    {
      deleteContentRange: {
        range: {
          startIndex: entry.startIndex,
          endIndex: entry.endIndex,
        },
      },
    },
  ];
}

/**
 * Build requests to update a modified block.
 * The named range tracks the current position in the document.
 */
export function buildModifyRequests(
  block: Block,
  entry: BlockMapEntry
): docs_v1.Schema$Request[] {
  if (block.readonly) return []; // Skip readonly blocks

  const requests: docs_v1.Schema$Request[] = [];

  const { startIndex, endIndex } = entry;

  // Delete all existing content except the mandatory trailing \n
  if (startIndex < endIndex - 1) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex,
          endIndex: endIndex - 1,
        },
      },
    });
  }

  // Determine text to insert
  const { plainText, insertText: text, styleRequests } = prepareTextAndStyles(
    block,
    startIndex
  );

  if (text) {
    requests.push({
      insertText: {
        location: { index: startIndex },
        text,
      },
    });
  }

  // Compute the actual paragraph range after delete+insert.
  // After deleting old content, the paragraph is just startIndex + \n.
  // After inserting new text, the paragraph is startIndex to startIndex + text.length + 1 (\n).
  const newEndIndex = startIndex + (text?.length ?? 0) + 1;

  // Apply paragraph style
  const styleType = namedStyleType(block.content);
  requests.push({
    updateParagraphStyle: {
      range: { startIndex, endIndex: newEndIndex },
      paragraphStyle: { namedStyleType: styleType },
      fields: "namedStyleType",
    },
  });

  // Apply alignment if style token present
  const alignToken = block.styleTokens.find((t) => t.startsWith("text-"));
  if (alignToken) {
    const alignment = alignmentValue(alignToken);
    if (alignment) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex: newEndIndex },
          paragraphStyle: { alignment },
          fields: "alignment",
        },
      });
    }
  }

  // Apply inline text styles
  requests.push(...styleRequests);

  // Handle list bullets
  const listInfo = parseListPrefix(block.content);
  if (listInfo) {
    const existingListId = entry.listId;
    if (!existingListId) {
      // Need to add bullets
      requests.push({
        createParagraphBullets: {
          range: { startIndex, endIndex: newEndIndex },
          bulletPreset: listInfo.isOrdered
            ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
            : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
    }
  } else if (entry.listId) {
    // Was a list item, now it's not
    requests.push({
      deleteParagraphBullets: {
        range: { startIndex, endIndex: newEndIndex },
      },
    });
  }

  return requests;
}

/**
 * Build requests to insert a new block at the given position.
 */
export function buildInsertRequests(
  block: Block,
  insertIndex: number
): { requests: docs_v1.Schema$Request[]; insertedLength: number } {
  const requests: docs_v1.Schema$Request[] = [];

  // Insert a newline to create the new paragraph
  requests.push({
    insertText: {
      location: { index: insertIndex },
      text: "\n",
    },
  });

  const paraStart = insertIndex;
  const paraEnd = insertIndex + 1; // \n is the paragraph

  const { insertText: text, styleRequests } = prepareTextAndStyles(
    block,
    paraStart
  );

  if (text) {
    requests.push({
      insertText: {
        location: { index: paraStart },
        text,
      },
    });
  }

  // Always set paragraph style — inserted paragraphs inherit from adjacent
  // content, so even NORMAL_TEXT must be set explicitly
  const paraRange = { startIndex: paraStart, endIndex: paraEnd + (text?.length ?? 0) };
  const styleType = namedStyleType(block.content);
  requests.push({
    updateParagraphStyle: {
      range: paraRange,
      paragraphStyle: { namedStyleType: styleType },
      fields: "namedStyleType",
    },
  });

  // Apply alignment if style token present
  const alignToken = block.styleTokens.find((t) => t.startsWith("text-"));
  if (alignToken) {
    const alignment = alignmentValue(alignToken);
    if (alignment) {
      requests.push({
        updateParagraphStyle: {
          range: paraRange,
          paragraphStyle: { alignment },
          fields: "alignment",
        },
      });
    }
  }

  // Apply text styles
  requests.push(...styleRequests);

  // Handle list bullets
  const listInfo = parseListPrefix(block.content);
  if (listInfo) {
    const endIdx = paraStart + (text?.length ?? 0) + 1;
    requests.push({
      createParagraphBullets: {
        range: { startIndex: paraStart, endIndex: endIdx },
        bulletPreset: listInfo.isOrdered
          ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }

  // 1 for \n + actual plain text length
  const insertedLength = 1 + (text?.length ?? 0);

  return { requests, insertedLength };
}

/**
 * Prepare the plain text to insert and inline style requests.
 */
export function prepareTextAndStyles(
  block: Block,
  docStartIndex: number
): { plainText: string; insertText: string | null; styleRequests: docs_v1.Schema$Request[] } {
  let rawContent = block.content;

  // Strip heading prefix
  rawContent = stripHeadingPrefix(rawContent);

  // Strip list prefix and add nesting tabs
  const listInfo = parseListPrefix(block.content);
  if (listInfo) {
    rawContent = stripListPrefix(rawContent);
    rawContent = addNestingTabs(rawContent, listInfo.nestingLevel);
  }

  // Skip image blocks — handled separately
  if (block.type === "image") {
    return { plainText: "", insertText: null, styleRequests: [] };
  }

  // Skip table blocks — handled separately
  if (block.type === "table") {
    return { plainText: "", insertText: null, styleRequests: [] };
  }

  const { plainText, spans } = parseInlineMarkdown(rawContent);
  const styleRequests: docs_v1.Schema$Request[] = [];

  // Clear inherited inline styles on the full range first — inserted text
  // inherits styling from adjacent content, so we reset before applying ours
  if (plainText) {
    styleRequests.push({
      updateTextStyle: {
        range: {
          startIndex: docStartIndex,
          endIndex: docStartIndex + plainText.length,
        },
        textStyle: {},
        fields: "bold,italic,link,weightedFontFamily",
      },
    });
  }

  // Then apply specific inline styles on their respective spans
  styleRequests.push(...buildTextStyleRequests(spans, docStartIndex));

  return {
    plainText,
    insertText: plainText || null,
    styleRequests,
  };
}
