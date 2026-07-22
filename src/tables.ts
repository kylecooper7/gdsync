/**
 * tables.ts — Table serialization and surgical cell update logic.
 */

import { docs_v1 } from "googleapis";
import { parseInlineMarkdown, buildTextStyleRequests } from "./deserialize.js";

export type ParsedTable = {
  headers: string[];
  rows: string[][];
};

/**
 * Parse a markdown table string into a 2D array.
 * Row 0 is headers; subsequent rows are data rows.
 * The separator row (| --- | --- |) is excluded.
 */
/**
 * Normalize a markdown table to canonical form: `| a | b |` rows, a `| --- |`
 * separator, and every row padded/truncated to the header's column count.
 * Used so verification tolerates lenient agent input (missing separator, uneven
 * columns, odd spacing) that gdsync normalizes when it renders the table.
 */
export function canonicalizeTableContent(content: string): string {
  const { headers, rows } = parseMarkdownTable(content);
  if (headers.length === 0) return content.trim();
  const cols = headers.length;
  const fit = (row: string[]): string[] => {
    const r = row.slice(0, cols);
    while (r.length < cols) r.push("");
    return r;
  };
  const lines = [
    "| " + fit(headers).join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
    ...rows.map((row) => "| " + fit(row).join(" | ") + " |"),
  ];
  return lines.join("\n");
}

export function parseMarkdownTable(markdown: string): ParsedTable {
  const lines = markdown.split("\n").filter((l) => l.trim().startsWith("|"));

  if (lines.length < 2) {
    return { headers: [], rows: [] };
  }

  const parseRow = (line: string): string[] =>
    line
      .split(/(?<!\\)\|/) // split on unescaped pipes only
      .slice(1, -1) // remove leading/trailing empty segments
      .map((cell) => cell.trim().replace(/\\\|/g, "|")); // unescape \| -> |

  const isSeparator = (line: string) => /^\|[\s\-:|]+\|$/.test(line.replace(/\s/g, ""));

  const headerLine = lines[0];
  const headers = parseRow(headerLine);

  const dataRows: string[][] = [];
  for (const line of lines.slice(1)) {
    if (isSeparator(line)) continue;
    dataRows.push(parseRow(line));
  }

  return { headers, rows: dataRows };
}

/**
 * Compare two parsed tables cell by cell.
 * Returns a list of changed cells: { rowIndex, colIndex, newText }
 * rowIndex 0 = header row.
 */
export type CellChange = {
  rowIndex: number;
  colIndex: number;
  newText: string;
};

export function diffTables(oldTable: ParsedTable, newTable: ParsedTable): CellChange[] {
  const changes: CellChange[] = [];

  const oldAll = [oldTable.headers, ...oldTable.rows];
  const newAll = [newTable.headers, ...newTable.rows];

  const rowCount = Math.min(oldAll.length, newAll.length);
  const colCount = Math.min(
    oldAll[0]?.length ?? 0,
    newAll[0]?.length ?? 0
  );

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const oldCell = oldAll[r]?.[c] ?? "";
      const newCell = newAll[r]?.[c] ?? "";
      if (oldCell !== newCell) {
        changes.push({ rowIndex: r, colIndex: c, newText: newCell });
      }
    }
  }

  return changes;
}

/**
 * Create a CellChange for every non-empty cell in a parsed table.
 * Used to fill newly inserted (empty) tables.
 */
export function allCellsAsChanges(parsed: ParsedTable): CellChange[] {
  const changes: CellChange[] = [];
  for (let c = 0; c < parsed.headers.length; c++) {
    if (parsed.headers[c]) {
      changes.push({ rowIndex: 0, colIndex: c, newText: parsed.headers[c] });
    }
  }
  for (let r = 0; r < parsed.rows.length; r++) {
    for (let c = 0; c < parsed.rows[r].length; c++) {
      if (parsed.rows[r][c]) {
        changes.push({ rowIndex: r + 1, colIndex: c, newText: parsed.rows[r][c] });
      }
    }
  }
  return changes;
}

/**
 * Validate that the agent hasn't changed the table dimensions.
 * Returns an error message if dimensions changed, null if OK.
 */
export function validateTableDimensions(
  oldTable: ParsedTable,
  newTable: ParsedTable,
  blockId: string | null
): string | null {
  const oldRows = oldTable.rows.length + 1; // +1 for header
  const newRows = newTable.rows.length + 1;
  const oldCols = oldTable.headers.length;
  const newCols = newTable.headers.length;

  if (oldRows !== newRows || oldCols !== newCols) {
    return (
      `Commit error: Table row/column count changed in ${blockId ?? "new block"}. ` +
      `Adding/removing rows and columns is not supported in v1. ` +
      `Edit the table structure directly in Google Docs.`
    );
  }
  return null;
}

/**
 * Build requests to update specific cells in a Docs table.
 * Requires the current document JSON to locate cell indexes.
 * Cells are processed in reverse document order to avoid index shifting.
 */
export function buildTableCellUpdateRequests(
  docTable: docs_v1.Schema$Table,
  changes: CellChange[]
): { requests: docs_v1.Schema$Request[]; netDelta: number } {
  // Sort changes in reverse document order (highest row/col index first)
  const sortedChanges = [...changes].sort((a, b) => {
    if (b.rowIndex !== a.rowIndex) return b.rowIndex - a.rowIndex;
    return b.colIndex - a.colIndex;
  });

  const requests: docs_v1.Schema$Request[] = [];
  // Net character change across all cell edits — callers use this to shift the
  // indices of any content inserted AFTER the table in the same commit.
  let netDelta = 0;

  for (const change of sortedChanges) {
    const row = docTable.tableRows?.[change.rowIndex];
    if (!row) continue;
    const cell = row.tableCells?.[change.colIndex];
    if (!cell) continue;

    const firstPara = cell.content?.find((el) => el.paragraph);
    if (!firstPara) continue;

    const paraStart = firstPara.startIndex!;
    const paraEnd = firstPara.endIndex!;
    const oldLen = Math.max(0, paraEnd - 1 - paraStart);

    // Delete existing content (preserve mandatory trailing \n)
    if (paraStart < paraEnd - 1) {
      requests.push({
        deleteContentRange: {
          range: {
            startIndex: paraStart,
            endIndex: paraEnd - 1,
          },
        },
      });
    }

    // Insert new text with inline formatting (bold / italic / code / link).
    // parseInlineMarkdown is inline-only, so a leading "#" or "-" stays literal.
    const { plainText, spans } = parseInlineMarkdown(change.newText ?? "");
    if (plainText) {
      requests.push({
        insertText: { location: { index: paraStart }, text: plainText },
      });
      // Reset inherited inline styles on the inserted range, then apply the
      // cell's own spans (mirrors how paragraph text is styled).
      requests.push({
        updateTextStyle: {
          range: { startIndex: paraStart, endIndex: paraStart + plainText.length },
          textStyle: {},
          fields: "bold,italic,link,weightedFontFamily",
        },
      });
      requests.push(...buildTextStyleRequests(spans, paraStart));
    }

    // The doc holds the plain text (styling is metadata), so shifts use its length.
    netDelta += plainText.length - oldLen;
  }

  return { requests, netDelta };
}

/**
 * Build an insertTable request.
 */
export function insertTableRequest(
  rows: number,
  columns: number,
  index: number
): docs_v1.Schema$Request {
  return {
    insertTable: {
      rows,
      columns,
      location: { index },
    },
  };
}
