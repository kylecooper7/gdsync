import { describe, it, expect } from "vitest";
import {
  serializeParagraph,
  serializeTable,
  DocParagraph,
  DocTable,
  ListsMap,
} from "../serialize.js";

const noopImageResolver = (_id: string) => "assets/img_001.png";

describe("serializeParagraph", () => {
  it("serializes plain normal text paragraph", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 12, textRun: { content: "Hello world\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("Hello world");
    expect(result.styleToken).toBeNull();
    expect(result.isListItem).toBe(false);
  });

  it("serializes HEADING_1", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 10, textRun: { content: "My Title\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "HEADING_1" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("# My Title");
  });

  it("serializes bold text", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 7, textRun: { content: "Hello ", textStyle: {} } },
        { startIndex: 7, endIndex: 13, textRun: { content: "world\n", textStyle: { bold: true } } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("Hello **world**");
  });

  it("serializes italic text", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 7, textRun: { content: "Hello *", textStyle: { italic: true } } },
        { startIndex: 7, endIndex: 8, textRun: { content: "\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("*Hello **");
  });

  it("serializes a link", () => {
    const para: DocParagraph = {
      elements: [
        {
          startIndex: 1,
          endIndex: 5,
          textRun: {
            content: "link",
            textStyle: { link: { url: "https://example.com" } },
          },
        },
        { startIndex: 5, endIndex: 6, textRun: { content: "\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("[link](https://example.com)");
  });

  it("serializes inline code (Courier New font)", () => {
    const para: DocParagraph = {
      elements: [
        {
          startIndex: 1,
          endIndex: 5,
          textRun: {
            content: "code",
            textStyle: { weightedFontFamily: { fontFamily: "Courier New" } },
          },
        },
        { startIndex: 5, endIndex: 6, textRun: { content: "\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("`code`");
  });

  it("serializes unordered list item", () => {
    const lists: ListsMap = {
      "kix.abc": {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "•" }],
        },
      },
    };
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 6, textRun: { content: "Item\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      bullet: { listId: "kix.abc", nestingLevel: 0 },
    };
    const result = serializeParagraph(para, lists, noopImageResolver);
    expect(result.content).toBe("- Item");
    expect(result.isListItem).toBe(true);
  });

  it("serializes ordered list item", () => {
    const lists: ListsMap = {
      "kix.def": {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL" }],
        },
      },
    };
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 6, textRun: { content: "Item\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      bullet: { listId: "kix.def", nestingLevel: 0 },
    };
    const result = serializeParagraph(para, lists, noopImageResolver);
    expect(result.content).toBe("1. Item");
    expect(result.isListItem).toBe(true);
  });

  it("serializes centered paragraph with style token", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 8, textRun: { content: "Centered\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.styleToken).toBe("text-center");
  });

  it("strips trailing newline", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 5, textRun: { content: "Test\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content.endsWith("\n")).toBe(false);
  });

  it("handles TITLE as HEADING_1", () => {
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 6, textRun: { content: "Title\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "TITLE" },
    };
    const result = serializeParagraph(para, {}, noopImageResolver);
    expect(result.content).toBe("# Title");
  });

  it("handles nested list item (nestingLevel=1)", () => {
    const lists: ListsMap = {
      "kix.abc": {
        listProperties: {
          nestingLevels: [{ glyphSymbol: "•" }, { glyphSymbol: "○" }],
        },
      },
    };
    const para: DocParagraph = {
      elements: [
        { startIndex: 1, endIndex: 8, textRun: { content: "Nested\n", textStyle: {} } },
      ],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      bullet: { listId: "kix.abc", nestingLevel: 1 },
    };
    const result = serializeParagraph(para, lists, noopImageResolver);
    expect(result.content).toBe("  - Nested");
  });
});

describe("serializeTable", () => {
  const simpleTable: DocTable = {
    rows: 2,
    columns: 2,
    tableRows: [
      {
        tableCells: [
          {
            content: [
              {
                startIndex: 1,
                endIndex: 10,
                paragraph: {
                  elements: [
                    { startIndex: 1, endIndex: 8, textRun: { content: "Header1\n", textStyle: {} } },
                  ],
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                },
              },
            ],
          },
          {
            content: [
              {
                startIndex: 11,
                endIndex: 20,
                paragraph: {
                  elements: [
                    { startIndex: 11, endIndex: 18, textRun: { content: "Header2\n", textStyle: {} } },
                  ],
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                },
              },
            ],
          },
        ],
      },
      {
        tableCells: [
          {
            content: [
              {
                startIndex: 21,
                endIndex: 28,
                paragraph: {
                  elements: [
                    { startIndex: 21, endIndex: 27, textRun: { content: "Cell1\n", textStyle: {} } },
                  ],
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                },
              },
            ],
          },
          {
            content: [
              {
                startIndex: 29,
                endIndex: 36,
                paragraph: {
                  elements: [
                    { startIndex: 29, endIndex: 35, textRun: { content: "Cell2\n", textStyle: {} } },
                  ],
                  paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it("serializes a simple table", () => {
    const { content, isComplex } = serializeTable(simpleTable);
    expect(isComplex).toBe(false);
    expect(content).toContain("| Header1 | Header2 |");
    expect(content).toContain("| Cell1 | Cell2 |");
  });

  it("marks complex table (merged cells) as readonly", () => {
    const complexTable: DocTable = {
      rows: 1,
      columns: 2,
      tableRows: [
        {
          tableCells: [
            {
              content: [
                {
                  startIndex: 1,
                  endIndex: 5,
                  paragraph: {
                    elements: [
                      { startIndex: 1, endIndex: 4, textRun: { content: "A\n", textStyle: {} } },
                    ],
                  },
                },
              ],
              tableCellStyle: { columnSpan: 2 },
            },
          ],
        },
      ],
    };
    const { isComplex } = serializeTable(complexTable);
    expect(isComplex).toBe(true);
  });
});
