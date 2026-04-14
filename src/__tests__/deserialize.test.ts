import { describe, it, expect } from "vitest";
import {
  parseInlineMarkdown,
  buildInsertRequests,
  buildModifyRequests,
  buildDeleteRequests,
} from "../deserialize.js";

describe("parseInlineMarkdown", () => {
  it("parses plain text with no spans", () => {
    const { plainText, spans } = parseInlineMarkdown("Hello world");
    expect(plainText).toBe("Hello world");
    expect(spans).toHaveLength(0);
  });

  it("parses bold text", () => {
    const { plainText, spans } = parseInlineMarkdown("Hello **world**");
    expect(plainText).toBe("Hello world");
    const boldSpan = spans.find((s) => s.bold);
    expect(boldSpan).toBeDefined();
    expect(boldSpan!.startOffset).toBe(6);
    expect(boldSpan!.endOffset).toBe(11);
  });

  it("parses italic text", () => {
    const { plainText, spans } = parseInlineMarkdown("Hello *world*");
    expect(plainText).toBe("Hello world");
    const italicSpan = spans.find((s) => s.italic);
    expect(italicSpan).toBeDefined();
    expect(italicSpan!.startOffset).toBe(6);
    expect(italicSpan!.endOffset).toBe(11);
  });

  it("parses bold+italic text", () => {
    const { plainText, spans } = parseInlineMarkdown("***bold italic***");
    expect(plainText).toBe("bold italic");
    const span = spans.find((s) => s.bold && s.italic);
    expect(span).toBeDefined();
  });

  it("parses inline code", () => {
    const { plainText, spans } = parseInlineMarkdown("Use `code` here");
    expect(plainText).toBe("Use code here");
    const codeSpan = spans.find((s) => s.code);
    expect(codeSpan).toBeDefined();
    expect(codeSpan!.startOffset).toBe(4);
    expect(codeSpan!.endOffset).toBe(8);
  });

  it("parses a link", () => {
    const { plainText, spans } = parseInlineMarkdown("[click here](https://example.com)");
    expect(plainText).toBe("click here");
    const linkSpan = spans.find((s) => s.linkUrl);
    expect(linkSpan).toBeDefined();
    expect(linkSpan!.linkUrl).toBe("https://example.com");
    expect(linkSpan!.startOffset).toBe(0);
    expect(linkSpan!.endOffset).toBe(10);
  });

  it("parses bold link (link wraps bold)", () => {
    const { plainText, spans } = parseInlineMarkdown("[**bold link**](https://example.com)");
    expect(plainText).toBe("bold link");
    // Should have both bold and link on the same span range
    const span = spans.find((s) => s.bold);
    expect(span).toBeDefined();
    const linkSpan = spans.find((s) => s.linkUrl);
    expect(linkSpan).toBeDefined();
  });

  it("handles empty string", () => {
    const { plainText, spans } = parseInlineMarkdown("");
    expect(plainText).toBe("");
    expect(spans).toHaveLength(0);
  });

  it("handles mixed formatting", () => {
    const { plainText, spans } = parseInlineMarkdown("Hello **world** and *italic*");
    expect(plainText).toBe("Hello world and italic");
    const boldSpan = spans.find((s) => s.bold);
    expect(boldSpan).toBeDefined();
    const italicSpan = spans.find((s) => s.italic);
    expect(italicSpan).toBeDefined();
  });
});

describe("buildInsertRequests", () => {
  it("returns requests and correct insertedLength for plain text", () => {
    const block = {
      blockId: null,
      content: "Hello world",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const { requests, insertedLength } = buildInsertRequests(block, 10);
    // Should include a \n insert and text insert
    const textInserts = requests.filter((r) => r.insertText);
    expect(textInserts.length).toBeGreaterThanOrEqual(1);
    // insertedLength = 1 (\n) + 11 ("Hello world")
    expect(insertedLength).toBe(12);
  });

  it("always sets paragraph style, even for NORMAL_TEXT", () => {
    const block = {
      blockId: null,
      content: "Plain paragraph",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const { requests } = buildInsertRequests(block, 10);
    const paraStyle = requests.find((r) => r.updateParagraphStyle);
    expect(paraStyle).toBeDefined();
    expect(paraStyle!.updateParagraphStyle!.paragraphStyle!.namedStyleType).toBe("NORMAL_TEXT");
  });

  it("clears inherited inline styles before applying new ones", () => {
    const block = {
      blockId: null,
      content: "Hello **bold**",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const { requests } = buildInsertRequests(block, 10);
    const styleReqs = requests.filter((r) => r.updateTextStyle);
    // First style request should clear all inline styles on full range
    expect(styleReqs.length).toBeGreaterThanOrEqual(1);
    const clearReq = styleReqs[0];
    expect(clearReq.updateTextStyle!.fields).toContain("bold");
    expect(clearReq.updateTextStyle!.fields).toContain("italic");
    // Subsequent requests apply specific styles (bold on "bold")
    const boldReq = styleReqs.find(
      (r) => r.updateTextStyle?.textStyle?.bold === true
    );
    expect(boldReq).toBeDefined();
  });

  it("returns insertedLength based on plain text, not markdown length", () => {
    const block = {
      blockId: null,
      content: "Hello **world**",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const { insertedLength } = buildInsertRequests(block, 10);
    // Plain text is "Hello world" (11 chars), not "Hello **world**" (15 chars)
    // insertedLength = 1 (\n) + 11
    expect(insertedLength).toBe(12);
  });

  it("strips heading prefix from inserted text", () => {
    const block = {
      blockId: null,
      content: "## My Heading",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const { requests, insertedLength } = buildInsertRequests(block, 10);
    // Inserted text should be "My Heading" (10 chars), not "## My Heading"
    const textInsert = requests.find(
      (r) => r.insertText && r.insertText.text !== "\n"
    );
    expect(textInsert?.insertText?.text).toBe("My Heading");
    expect(insertedLength).toBe(11); // 1 + 10
  });

  it("includes updateParagraphStyle for headings", () => {
    const block = {
      blockId: null,
      content: "# Title",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const { requests } = buildInsertRequests(block, 10);
    const styleReq = requests.find((r) => r.updateParagraphStyle);
    expect(styleReq).toBeDefined();
    expect(styleReq!.updateParagraphStyle!.paragraphStyle!.namedStyleType).toBe("HEADING_1");
  });

  it("returns insertedLength of 1 for image blocks (only newline)", () => {
    const block = {
      blockId: null,
      content: "![alt](assets/img.png)",
      styleTokens: [],
      readonly: false,
      type: "image" as const,
    };
    const { insertedLength } = buildInsertRequests(block, 10);
    expect(insertedLength).toBe(1);
  });
});

describe("buildModifyRequests", () => {
  it("generates delete + insert + style requests for text block", () => {
    const block = {
      blockId: "blk_1",
      content: "Updated text",
      styleTokens: [],
      readonly: false,
      type: "paragraph" as const,
    };
    const entry = {
      blockId: "blk_1",
      namedRangeId: "nr_1",
      namedRangeName: "blk_1",
      startIndex: 10,
      endIndex: 25,
      type: "paragraph" as const,
    };
    const requests = buildModifyRequests(block, entry);
    expect(requests.some((r) => r.deleteContentRange)).toBe(true);
    expect(requests.some((r) => r.insertText)).toBe(true);
    expect(requests.some((r) => r.updateParagraphStyle)).toBe(true);
  });

  it("returns empty array for readonly blocks", () => {
    const block = {
      blockId: "blk_1",
      content: "content",
      styleTokens: [],
      readonly: true,
      type: "paragraph" as const,
    };
    const entry = {
      blockId: "blk_1",
      namedRangeId: "nr_1",
      namedRangeName: "blk_1",
      startIndex: 10,
      endIndex: 25,
      type: "paragraph" as const,
    };
    expect(buildModifyRequests(block, entry)).toHaveLength(0);
  });
});

describe("buildDeleteRequests", () => {
  it("generates a deleteContentRange request", () => {
    const entry = {
      blockId: "blk_1",
      namedRangeId: "nr_1",
      namedRangeName: "blk_1",
      startIndex: 10,
      endIndex: 25,
      type: "paragraph" as const,
    };
    const requests = buildDeleteRequests(entry);
    expect(requests).toHaveLength(1);
    expect(requests[0].deleteContentRange?.range).toEqual({
      startIndex: 10,
      endIndex: 25,
    });
  });
});
