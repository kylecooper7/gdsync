import { describe, it, expect } from "vitest";
import { formatCommentsFile, CommentThread } from "../comments.js";

function makeThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    threadId: "AAAA1234",
    blockId: "blk_3",
    highlightedText: "some highlighted text",
    anchorOffset: 42,
    resolved: false,
    rootComment: {
      author: "Alice",
      date: "2026-03-15",
      content: "Fix this paragraph.",
    },
    replies: [],
    ...overrides,
  };
}

describe("formatCommentsFile", () => {
  it("returns sentinel for empty thread list", () => {
    const result = formatCommentsFile([]);
    expect(result).toBe("No open comments.\n");
  });

  it("formats a single thread with no replies", () => {
    const threads = [makeThread()];
    const result = formatCommentsFile(threads);

    expect(result).toContain('[#AAAA1234 | blk_3 | "some highlighted text"]');
    expect(result).toContain("Alice (2026-03-15): Fix this paragraph.");
  });

  it("formats replies with 2-space indent", () => {
    const threads = [
      makeThread({
        replies: [
          { author: "Bob", date: "2026-03-16", content: "Which part?" },
          { author: "Alice", date: "2026-03-16", content: "The second sentence." },
        ],
      }),
    ];
    const result = formatCommentsFile(threads);

    expect(result).toContain("  Bob (2026-03-16): Which part?");
    expect(result).toContain("  Alice (2026-03-16): The second sentence.");
  });

  it("separates multiple threads with blank lines", () => {
    const threads = [
      makeThread({ threadId: "AAAA1111", blockId: "blk_1" }),
      makeThread({ threadId: "AAAA2222", blockId: "blk_5" }),
    ];
    const result = formatCommentsFile(threads);
    const sections = result.trim().split("\n\n");
    expect(sections).toHaveLength(2);
  });

  it("truncates highlighted text longer than 120 characters", () => {
    const longText = "A".repeat(150);
    const threads = [makeThread({ highlightedText: longText })];
    const result = formatCommentsFile(threads);

    // Should be truncated to 117 chars + "..."
    expect(result).toContain("A".repeat(117) + "...");
    expect(result).not.toContain("A".repeat(118));
  });

  it("does not truncate text at exactly 120 characters", () => {
    const exactText = "B".repeat(120);
    const threads = [makeThread({ highlightedText: exactText })];
    const result = formatCommentsFile(threads);

    expect(result).toContain("B".repeat(120));
    expect(result).not.toContain("...");
  });

  it("uses 'unanchored' when blockId is null", () => {
    const threads = [makeThread({ blockId: null })];
    const result = formatCommentsFile(threads);

    expect(result).toContain("[#AAAA1234 | unanchored |");
  });

  it("includes [resolved] prefix for resolved threads", () => {
    const threads = [makeThread({ resolved: true })];
    const result = formatCommentsFile(threads);

    expect(result).toContain("[resolved] [#AAAA1234 |");
  });

  it("does not include [resolved] prefix for open threads", () => {
    const threads = [makeThread({ resolved: false })];
    const result = formatCommentsFile(threads);

    expect(result).not.toContain("[resolved]");
  });

  it("formats a complete thread matching the spec example", () => {
    const threads = [
      {
        threadId: "AAAABx3k0Bw",
        blockId: "blk_2",
        highlightedText: "grew by approximately 40%",
        anchorOffset: 100,
        resolved: false,
        rootComment: {
          author: "Carol",
          date: "2026-03-18",
          content: "This doesn't match the 35% figure in the executive summary. Which is correct?",
        },
        replies: [],
      },
      {
        threadId: "AAAACy4l1Cx",
        blockId: "blk_5",
        highlightedText: "onboarding process",
        anchorOffset: 250,
        resolved: false,
        rootComment: {
          author: "Alice",
          date: "2026-03-17",
          content: "This section is too long. Condense to 2 paragraphs max and move the details to an appendix.",
        },
        replies: [
          {
            author: "Bob",
            date: "2026-03-17",
            content: "Agreed, it buries the key points.",
          },
        ],
      },
    ];
    const result = formatCommentsFile(threads);

    expect(result).toContain('[#AAAABx3k0Bw | blk_2 | "grew by approximately 40%"]');
    expect(result).toContain('[#AAAACy4l1Cx | blk_5 | "onboarding process"]');
    expect(result).toContain("  Bob (2026-03-17): Agreed, it buries the key points.");
  });

  it("handles thread with empty highlighted text", () => {
    const threads = [makeThread({ highlightedText: "" })];
    const result = formatCommentsFile(threads);

    expect(result).toContain('[#AAAA1234 | blk_3 | ""]');
  });

  it("preserves thread ordering (by anchorOffset from input)", () => {
    const threads = [
      makeThread({ threadId: "FIRST", blockId: "blk_1", anchorOffset: 10 }),
      makeThread({ threadId: "SECOND", blockId: "blk_5", anchorOffset: 200 }),
      makeThread({ threadId: "THIRD", blockId: "blk_9", anchorOffset: 500 }),
    ];
    const result = formatCommentsFile(threads);

    const firstPos = result.indexOf("#FIRST");
    const secondPos = result.indexOf("#SECOND");
    const thirdPos = result.indexOf("#THIRD");

    expect(firstPos).toBeLessThan(secondPos);
    expect(secondPos).toBeLessThan(thirdPos);
  });
});
