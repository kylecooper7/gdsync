import { describe, it, expect } from "vitest";
import { buildInsertRequests, buildDeleteRequests } from "../deserialize.js";
import { buildTableCellUpdateRequests } from "../tables.js";
import { Block, BlockMapEntry } from "../types.js";

// --- helpers -------------------------------------------------------------

function block(content: string): Block {
  return {
    blockId: null,
    content,
    styleTokens: [],
    readonly: false,
    type: /^\s*([-*]|\d+[.)])\s/.test(content) ? "list_item" : "paragraph",
  };
}

function entry(startIndex: number, endIndex: number): BlockMapEntry {
  return {
    blockId: "blk_x",
    namedRangeId: "nr",
    namedRangeName: "blk_x",
    startIndex,
    endIndex,
    type: "paragraph",
  };
}

// Access request fields without fighting the union type in tests.
const asAny = (r: unknown) => r as any;
const inserts = (reqs: unknown[]) => reqs.map(asAny).filter((r) => r.insertText);

// --- buildInsertRequests: index math ------------------------------------

describe("buildInsertRequests — index math", () => {
  it("mid-doc: newline and content both go at insertIndex", () => {
    const { requests, insertedLength } = buildInsertRequests(block("Hello"), 10);
    const ins = inserts(requests);
    expect(ins[0].insertText.location.index).toBe(10);
    expect(ins[0].insertText.text).toBe("\n");
    expect(ins[1].insertText.text).toBe("Hello");
    expect(ins[1].insertText.location.index).toBe(10);
    expect(insertedLength).toBe(6); // "Hello" + "\n"
  });

  it("atDocEnd: content is placed AFTER the newline (index + 1)", () => {
    // Appending at the document's terminal newline position.
    const { requests } = buildInsertRequests(block("Hi"), 41, true);
    const ins = inserts(requests);
    expect(ins[0].insertText.location.index).toBe(41); // the "\n"
    expect(ins[0].insertText.text).toBe("\n");
    expect(ins[1].insertText.location.index).toBe(42); // content after the newline
    expect(ins[1].insertText.text).toBe("Hi");
  });

  it("list item: creates bullets, does not clear them", () => {
    const { requests } = buildInsertRequests(block("- item"), 5);
    expect(requests.map(asAny).some((r) => r.createParagraphBullets)).toBe(true);
    expect(requests.map(asAny).some((r) => r.deleteParagraphBullets)).toBe(false);
  });

  it("non-list paragraph: clears any inherited bullet", () => {
    // Regression: a plain paragraph inserted next to list content must not keep
    // a bullet (e.g. right after a table that follows a list).
    const { requests } = buildInsertRequests(block("plain text"), 5);
    expect(requests.map(asAny).some((r) => r.deleteParagraphBullets)).toBe(true);
    expect(requests.map(asAny).some((r) => r.createParagraphBullets)).toBe(false);
  });
});

// --- buildDeleteRequests: boundary handling -----------------------------

describe("buildDeleteRequests — boundary handling", () => {
  it("mid-doc block: deletes the whole [start, end) range", () => {
    const reqs = buildDeleteRequests(entry(10, 20)).map(asAny);
    expect(reqs[0].deleteContentRange.range).toEqual({ startIndex: 10, endIndex: 20 });
  });

  it("last block: stops one short of the terminal newline", () => {
    const reqs = buildDeleteRequests(entry(10, 20), true).map(asAny);
    expect(reqs[0].deleteContentRange.range).toEqual({ startIndex: 10, endIndex: 19 });
  });

  it("last block that is only a newline: produces no delete request", () => {
    const reqs = buildDeleteRequests(entry(10, 11), true);
    expect(reqs).toHaveLength(0);
  });
});

// --- buildTableCellUpdateRequests: netDelta -----------------------------

describe("buildTableCellUpdateRequests — netDelta", () => {
  // Minimal 1x1 table whose only cell paragraph spans `oldText`.
  function tableWithCell(oldText: string) {
    return {
      tableRows: [
        {
          tableCells: [
            {
              content: [
                { paragraph: {}, startIndex: 5, endIndex: 5 + oldText.length + 1 },
              ],
            },
          ],
        },
      ],
    } as any;
  }

  it("reports a positive net delta when a cell grows", () => {
    const { netDelta } = buildTableCellUpdateRequests(tableWithCell("Bob"), [
      { rowIndex: 0, colIndex: 0, newText: "Bobby" },
    ]);
    expect(netDelta).toBe(2); // 5 - 3
  });

  it("reports a negative net delta when a cell shrinks", () => {
    const { netDelta } = buildTableCellUpdateRequests(tableWithCell("Bobby"), [
      { rowIndex: 0, colIndex: 0, newText: "Bo" },
    ]);
    expect(netDelta).toBe(-3); // 2 - 5
  });

  it("reports zero net delta for a same-length edit", () => {
    const { netDelta } = buildTableCellUpdateRequests(tableWithCell("Bob"), [
      { rowIndex: 0, colIndex: 0, newText: "Tom" },
    ]);
    expect(netDelta).toBe(0);
  });
});
