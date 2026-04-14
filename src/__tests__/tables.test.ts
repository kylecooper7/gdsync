import { describe, it, expect } from "vitest";
import { parseMarkdownTable, diffTables, validateTableDimensions, allCellsAsChanges } from "../tables.js";

describe("parseMarkdownTable", () => {
  it("parses a simple 2-column table", () => {
    const md = `| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |`;

    const { headers, rows } = parseMarkdownTable(md);
    expect(headers).toEqual(["Header 1", "Header 2"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["Cell 1", "Cell 2"]);
    expect(rows[1]).toEqual(["Cell 3", "Cell 4"]);
  });

  it("parses a 3-column table", () => {
    const md = `| A | B | C |
| - | - | - |
| 1 | 2 | 3 |`;

    const { headers, rows } = parseMarkdownTable(md);
    expect(headers).toEqual(["A", "B", "C"]);
    expect(rows[0]).toEqual(["1", "2", "3"]);
  });

  it("strips cell whitespace", () => {
    const md = `| Header 1  | Header 2  |
| ----------| ----------|
|  Cell 1   |   Cell 2  |`;

    const { rows } = parseMarkdownTable(md);
    expect(rows[0][0]).toBe("Cell 1");
    expect(rows[0][1]).toBe("Cell 2");
  });

  it("returns empty for malformed table", () => {
    const { headers } = parseMarkdownTable("not a table");
    expect(headers).toHaveLength(0);
  });
});

describe("diffTables", () => {
  it("returns no changes for identical tables", () => {
    const table = { headers: ["A", "B"], rows: [["1", "2"]] };
    expect(diffTables(table, table)).toHaveLength(0);
  });

  it("detects changed cell", () => {
    const oldTable = { headers: ["A", "B"], rows: [["1", "2"]] };
    const newTable = { headers: ["A", "B"], rows: [["1", "updated"]] };
    const changes = diffTables(oldTable, newTable);
    expect(changes).toHaveLength(1);
    expect(changes[0].rowIndex).toBe(1); // row 0 = headers, row 1 = data row
    expect(changes[0].colIndex).toBe(1);
    expect(changes[0].newText).toBe("updated");
  });

  it("detects changed header", () => {
    const oldTable = { headers: ["A", "B"], rows: [["1", "2"]] };
    const newTable = { headers: ["New A", "B"], rows: [["1", "2"]] };
    const changes = diffTables(oldTable, newTable);
    expect(changes).toHaveLength(1);
    expect(changes[0].rowIndex).toBe(0);
    expect(changes[0].colIndex).toBe(0);
    expect(changes[0].newText).toBe("New A");
  });
});

describe("validateTableDimensions", () => {
  it("passes for matching dimensions", () => {
    const table = { headers: ["A", "B"], rows: [["1", "2"]] };
    expect(validateTableDimensions(table, table, "blk_1")).toBeNull();
  });

  it("fails when row count changes", () => {
    const oldTable = { headers: ["A", "B"], rows: [["1", "2"], ["3", "4"]] };
    const newTable = { headers: ["A", "B"], rows: [["1", "2"]] };
    const result = validateTableDimensions(oldTable, newTable, "blk_1");
    expect(result).not.toBeNull();
    expect(result).toContain("blk_1");
  });

  it("fails when column count changes", () => {
    const oldTable = { headers: ["A", "B", "C"], rows: [["1", "2", "3"]] };
    const newTable = { headers: ["A", "B"], rows: [["1", "2"]] };
    const result = validateTableDimensions(oldTable, newTable, "blk_1");
    expect(result).not.toBeNull();
  });
});

describe("allCellsAsChanges", () => {
  it("creates a change for every non-empty cell", () => {
    const parsed = { headers: ["A", "B"], rows: [["1", "2"], ["3", "4"]] };
    const changes = allCellsAsChanges(parsed);
    expect(changes).toHaveLength(6); // 2 headers + 4 data cells
  });

  it("maps header row to rowIndex 0", () => {
    const parsed = { headers: ["H1", "H2"], rows: [["a", "b"]] };
    const changes = allCellsAsChanges(parsed);
    const headerChanges = changes.filter((c) => c.rowIndex === 0);
    expect(headerChanges).toHaveLength(2);
    expect(headerChanges[0]).toEqual({ rowIndex: 0, colIndex: 0, newText: "H1" });
    expect(headerChanges[1]).toEqual({ rowIndex: 0, colIndex: 1, newText: "H2" });
  });

  it("maps data rows starting at rowIndex 1", () => {
    const parsed = { headers: ["A"], rows: [["r1"], ["r2"]] };
    const changes = allCellsAsChanges(parsed);
    const dataChanges = changes.filter((c) => c.rowIndex > 0);
    expect(dataChanges).toHaveLength(2);
    expect(dataChanges[0]).toEqual({ rowIndex: 1, colIndex: 0, newText: "r1" });
    expect(dataChanges[1]).toEqual({ rowIndex: 2, colIndex: 0, newText: "r2" });
  });

  it("skips empty cells", () => {
    const parsed = { headers: ["A", "B"], rows: [["data", ""]] };
    const changes = allCellsAsChanges(parsed);
    // 2 headers + 1 non-empty data cell = 3
    expect(changes).toHaveLength(3);
    expect(changes.find((c) => c.newText === "")).toBeUndefined();
  });

  it("returns empty array for empty table", () => {
    const parsed = { headers: [], rows: [] };
    const changes = allCellsAsChanges(parsed);
    expect(changes).toHaveLength(0);
  });
});
