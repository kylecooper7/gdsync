/**
 * serialize.ts — Converts Google Docs paragraph/table JSON into markdown strings.
 * This runs during fetch and verify.
 */

// Google Docs API types (simplified)
type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  link?: { url: string };
  weightedFontFamily?: { fontFamily: string };
};

type TextRun = {
  content: string;
  textStyle?: TextStyle;
};

type InlineObjectElement = {
  inlineObjectId: string;
};

type ParagraphElement = {
  startIndex: number;
  endIndex: number;
  textRun?: TextRun;
  inlineObjectElement?: InlineObjectElement;
};

type ParagraphStyle = {
  namedStyleType?: string;
  alignment?: string;
};

type Bullet = {
  listId: string;
  nestingLevel?: number;
};

export type DocParagraph = {
  elements: ParagraphElement[];
  paragraphStyle?: ParagraphStyle;
  bullet?: Bullet;
};

type TableCell = {
  content: Array<{
    startIndex: number;
    endIndex: number;
    paragraph?: DocParagraph;
  }>;
  tableCellStyle?: {
    contentAlignment?: string;
    rowSpan?: number;
    columnSpan?: number;
  };
};

type TableRow = {
  tableCells: TableCell[];
};

export type DocTable = {
  rows: number;
  columns: number;
  tableRows: TableRow[];
};

type NestingLevel = {
  glyphType?: string;
  glyphSymbol?: string;
};

type ListProperties = {
  nestingLevels: NestingLevel[];
};

type ListEntry = {
  listProperties: ListProperties;
};

export type ListsMap = Record<string, ListEntry>;

// Image download callback: given inlineObjectId, returns local path like "assets/img_001.png"
export type ImageResolver = (inlineObjectId: string) => string;

// Style span extracted from paragraph elements
type StyleSpan = {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  linkUrl: string | null;
};

/**
 * Determine the heading prefix from namedStyleType.
 * Returns empty string for NORMAL_TEXT.
 */
function headingPrefix(namedStyleType: string | undefined): string {
  switch (namedStyleType) {
    case "HEADING_1":
    case "TITLE":
      return "# ";
    case "HEADING_2":
    case "SUBTITLE":
      return "## ";
    case "HEADING_3":
      return "### ";
    case "HEADING_4":
      return "#### ";
    case "HEADING_5":
      return "##### ";
    case "HEADING_6":
      return "###### ";
    default:
      return "";
  }
}

/**
 * Determine the list prefix from bullet info.
 * Returns null if not a list item.
 */
function listPrefix(bullet: Bullet, lists: ListsMap): string | null {
  const listEntry = lists[bullet.listId];
  if (!listEntry) return "- "; // fallback
  const nestingLevel = bullet.nestingLevel ?? 0;
  const levelProps = listEntry.listProperties.nestingLevels[nestingLevel];
  const indent = nestingLevel > 0 ? "  ".repeat(Math.min(nestingLevel, 2)) : "";

  if (levelProps?.glyphType) {
    // Ordered list
    return `${indent}1. `;
  } else {
    // Unordered list
    return `${indent}- `;
  }
}

/**
 * Convert a list of style spans into a markdown string.
 * Uses reverse-injection: collect all text first, then insert markers from right to left.
 */
function spansToMarkdown(spans: StyleSpan[]): string {
  if (spans.length === 0) return "";

  // Build a list of segments: { text, bold, italic, code, linkUrl }
  // We'll process left to right, emitting markdown inline markers.

  let result = "";
  for (const span of spans) {
    if (!span.text) continue;

    let inner = span.text;

    // Apply code (innermost)
    if (span.code) {
      inner = `\`${inner}\``;
    }

    // Apply bold+italic, bold, italic
    if (span.bold && span.italic) {
      inner = `***${inner}***`;
    } else if (span.bold) {
      inner = `**${inner}**`;
    } else if (span.italic) {
      inner = `*${inner}*`;
    }

    // Apply link (outermost)
    if (span.linkUrl) {
      inner = `[${inner}](${span.linkUrl})`;
    }

    result += inner;
  }

  return result;
}

/**
 * Serialize a single paragraph's elements to a markdown string.
 * imageResolver maps inlineObjectId → local asset path.
 */
function serializeParagraphElements(
  elements: ParagraphElement[],
  imageResolver: ImageResolver
): string {
  const spans: StyleSpan[] = [];

  for (const el of elements) {
    if (el.textRun) {
      const run = el.textRun;
      const style = run.textStyle ?? {};
      spans.push({
        text: run.content,
        bold: style.bold ?? false,
        italic: style.italic ?? false,
        code: style.weightedFontFamily?.fontFamily === "Courier New",
        linkUrl: style.link?.url ?? null,
      });
    } else if (el.inlineObjectElement) {
      const localPath = imageResolver(el.inlineObjectElement.inlineObjectId);
      // alt text is handled separately by the caller
      spans.push({ text: `![image](${localPath})`, bold: false, italic: false, code: false, linkUrl: null });
    }
  }

  // Strip trailing newline from last text span
  if (spans.length > 0) {
    const last = spans[spans.length - 1];
    last.text = last.text.replace(/\n$/, "");
    if (!last.text) spans.pop();
  }

  return spansToMarkdown(spans);
}

/**
 * Serialize a paragraph to markdown.
 * Returns { content, styleToken, type }
 */
export function serializeParagraph(
  para: DocParagraph,
  lists: ListsMap,
  imageResolver: ImageResolver,
  altTextResolver?: (inlineObjectId: string) => string
): { content: string; styleToken: string | null; isListItem: boolean; isImage: boolean } {
  const style = para.paragraphStyle;
  const namedStyleType = style?.namedStyleType;

  // Check if this is a pure image paragraph (single inlineObjectElement)
  const nonEmptyElements = para.elements.filter(
    (el) =>
      el.inlineObjectElement ||
      (el.textRun && el.textRun.content && el.textRun.content !== "\n")
  );
  const isImage =
    nonEmptyElements.length === 1 && !!nonEmptyElements[0].inlineObjectElement;

  let content: string;

  if (isImage) {
    const el = nonEmptyElements[0];
    const objId = el.inlineObjectElement!.inlineObjectId;
    const localPath = imageResolver(objId);
    const altText = altTextResolver ? altTextResolver(objId) : "image";
    content = `![${altText}](${localPath})`;
  } else {
    content = serializeParagraphElements(para.elements, imageResolver);

    // Prepend heading or list prefix
    if (para.bullet) {
      const prefix = listPrefix(para.bullet, lists);
      if (prefix !== null) {
        content = prefix + content;
      }
    } else {
      const prefix = headingPrefix(namedStyleType);
      content = prefix + content;
    }
  }

  // Determine alignment style token
  let styleToken: string | null = null;
  const alignment = style?.alignment;
  if (alignment === "CENTER") {
    styleToken = "text-center";
  } else if (alignment === "END" || alignment === "RIGHT") {
    styleToken = "text-right";
  }

  const isListItem = !!para.bullet;

  return { content, styleToken, isListItem, isImage };
}

/**
 * Check if a table is complex (merged cells, multi-paragraph cells, nested tables).
 */
function isComplexTable(table: DocTable): boolean {
  for (const row of table.tableRows) {
    for (const cell of row.tableCells) {
      const cs = cell.tableCellStyle;
      if (cs?.rowSpan && cs.rowSpan > 1) return true;
      if (cs?.columnSpan && cs.columnSpan > 1) return true;
      // More than one paragraph in a cell
      const paragraphs = cell.content.filter((el) => el.paragraph);
      if (paragraphs.length > 1) return true;
    }
  }
  return false;
}

/**
 * Extract plain text from a table cell's first paragraph.
 */
function cellText(cell: TableCell): string {
  const firstPara = cell.content.find((el) => el.paragraph);
  if (!firstPara?.paragraph) return "";
  const text = firstPara.paragraph.elements
    .map((el) => el.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
  return text;
}

/**
 * Determine column alignment from the separator row marker.
 * We use cell style contentAlignment.
 */
function columnAlignment(cell: TableCell): "left" | "center" | "right" {
  const align = cell.tableCellStyle?.contentAlignment;
  if (align === "MIDDLE" || align === "CENTER") return "center";
  if (align === "BOTTOM") return "right"; // approximation
  return "left";
}

/**
 * Serialize a table element to a markdown table string.
 * Returns { content, isComplex }
 */
export function serializeTable(table: DocTable): { content: string; isComplex: boolean } {
  if (isComplexTable(table)) {
    // Best-effort rendering
    let content = "";
    if (table.tableRows.length > 0) {
      const headerCells = table.tableRows[0].tableCells.map((c) => cellText(c));
      content += "| " + headerCells.join(" | ") + " |\n";
      content += "| " + headerCells.map(() => "---").join(" | ") + " |\n";
      for (const row of table.tableRows.slice(1)) {
        const cells = row.tableCells.map((c) => cellText(c));
        content += "| " + cells.join(" | ") + " |\n";
      }
    }
    content += "⚠ Complex table — edit directly in Google Docs";
    return { content: content.trim(), isComplex: true };
  }

  if (table.tableRows.length === 0) {
    return { content: "", isComplex: false };
  }

  const rows = table.tableRows;
  const headerRow = rows[0];
  const headerCells = headerRow.tableCells.map((c) => cellText(c));

  // Build separator with alignment
  const separators = headerRow.tableCells.map((c) => {
    const align = columnAlignment(c);
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });

  const lines: string[] = [];
  lines.push("| " + headerCells.join(" | ") + " |");
  lines.push("| " + separators.join(" | ") + " |");

  for (const row of rows.slice(1)) {
    const cells = row.tableCells.map((c) => cellText(c));
    lines.push("| " + cells.join(" | ") + " |");
  }

  return { content: lines.join("\n"), isComplex: false };
}
