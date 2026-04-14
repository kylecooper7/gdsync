import { describe, it, expect } from "vitest";
import { parseContentString, diffBlocks, writeContentFile } from "../contentFile.js";
import { Block } from "../types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("parseContentString", () => {
  it("parses basic blocks", () => {
    const raw = `---blk_1---
# Heading

---blk_2---
Normal paragraph

---blk_3---
- List item
`;
    const blocks = parseContentString(raw);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].blockId).toBe("blk_1");
    expect(blocks[0].content).toBe("# Heading");
    expect(blocks[1].blockId).toBe("blk_2");
    expect(blocks[1].content).toBe("Normal paragraph");
    expect(blocks[2].blockId).toBe("blk_3");
    expect(blocks[2].content).toBe("- List item");
  });

  it("parses a new block (bare ---)", () => {
    const raw = `---blk_1---
Existing paragraph

---
New paragraph

---blk_2---
Another existing
`;
    const blocks = parseContentString(raw);
    expect(blocks).toHaveLength(3);
    expect(blocks[1].blockId).toBeNull();
    expect(blocks[1].content).toBe("New paragraph");
  });

  it("parses style tokens on delimiter", () => {
    const raw = `---blk_1 text-center---
Centered text
`;
    const blocks = parseContentString(raw);
    expect(blocks[0].styleTokens).toContain("text-center");
    expect(blocks[0].readonly).toBe(false);
  });

  it("parses readonly token", () => {
    const raw = `---blk_1 readonly---
| A | B |
| - | - |
| 1 | 2 |
⚠ Complex table — edit directly in Google Docs
`;
    const blocks = parseContentString(raw);
    expect(blocks[0].readonly).toBe(true);
  });

  it("handles empty block content", () => {
    const raw = `---blk_1---

---blk_2---
text
`;
    const blocks = parseContentString(raw);
    expect(blocks[0].content).toBe("");
    expect(blocks[1].content).toBe("text");
  });

  it("infers paragraph type", () => {
    const raw = `---blk_1---
Normal text
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("paragraph");
  });

  it("infers list_item type", () => {
    const raw = `---blk_1---
- List item
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("list_item");
  });

  it("infers table type", () => {
    const raw = `---blk_1---
| H1 | H2 |
| -- | -- |
| a  | b  |
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("table");
  });

  it("infers image type", () => {
    const raw = `---blk_1---
![alt](assets/img_001.png)
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("image");
  });

  it("parses multiple style tokens", () => {
    const raw = `---blk_1 text-right readonly---
content
`;
    const [block] = parseContentString(raw);
    expect(block.styleTokens).toContain("text-right");
    expect(block.readonly).toBe(true);
  });
});

describe("diffBlocks", () => {
  const makeBlock = (id: string | null, content: string) => ({
    blockId: id,
    content,
    styleTokens: [] as string[],
    readonly: false,
    type: "paragraph" as const,
  });

  it("detects no changes when blocks are identical", () => {
    const blocks = [makeBlock("blk_1", "Hello"), makeBlock("blk_2", "World")];
    const diff = diffBlocks(blocks, blocks);
    expect(diff.modified).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.deleted).toHaveLength(0);
  });

  it("detects modified block", () => {
    const old = [makeBlock("blk_1", "Hello"), makeBlock("blk_2", "World")];
    const updated = [makeBlock("blk_1", "Hello"), makeBlock("blk_2", "Updated world")];
    const diff = diffBlocks(old, updated);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].block.content).toBe("Updated world");
  });

  it("detects deleted block", () => {
    const old = [makeBlock("blk_1", "Hello"), makeBlock("blk_2", "World")];
    const updated = [makeBlock("blk_1", "Hello")];
    const diff = diffBlocks(old, updated);
    expect(diff.deleted).toContain("blk_2");
  });

  it("detects new block (null ID)", () => {
    const old = [makeBlock("blk_1", "Hello"), makeBlock("blk_2", "World")];
    const updated = [
      makeBlock("blk_1", "Hello"),
      makeBlock(null, "New block"),
      makeBlock("blk_2", "World"),
    ];
    const diff = diffBlocks(old, updated);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].block.content).toBe("New block");
    expect(diff.added[0].insertAfterBlockId).toBe("blk_1");
  });

  it("detects agent-assigned ID as new block", () => {
    const old = [makeBlock("blk_1", "Hello")];
    const updated = [makeBlock("blk_1", "Hello"), makeBlock("blk_99", "Agent wrote this")];
    const diff = diffBlocks(old, updated);
    // blk_99 doesn't exist in old → treated as new
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].block.blockId).toBeNull();
  });

  it("handles multiple deletions", () => {
    const old = [makeBlock("blk_1", "a"), makeBlock("blk_2", "b"), makeBlock("blk_3", "c")];
    const updated = [makeBlock("blk_1", "a")];
    const diff = diffBlocks(old, updated);
    expect(diff.deleted).toHaveLength(2);
    expect(diff.deleted).toContain("blk_2");
    expect(diff.deleted).toContain("blk_3");
  });

  it("detects simple block swap as move (delete + add)", () => {
    const old = [makeBlock("blk_1", "a"), makeBlock("blk_2", "b"), makeBlock("blk_3", "c")];
    const updated = [makeBlock("blk_1", "a"), makeBlock("blk_3", "c"), makeBlock("blk_2", "b")];
    const diff = diffBlocks(old, updated);
    // One block is moved (deleted from old position, added at new)
    expect(diff.deleted).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].block.content).toBe(diff.deleted[0] === "blk_2" ? "b" : "c");
    expect(diff.modified).toHaveLength(0);
  });

  it("detects block moved to beginning", () => {
    const old = [makeBlock("blk_1", "a"), makeBlock("blk_2", "b"), makeBlock("blk_3", "c")];
    const updated = [makeBlock("blk_3", "c"), makeBlock("blk_1", "a"), makeBlock("blk_2", "b")];
    const diff = diffBlocks(old, updated);
    expect(diff.deleted).toHaveLength(1);
    expect(diff.deleted).toContain("blk_3");
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].block.content).toBe("c");
    expect(diff.added[0].insertAfterBlockId).toBeNull(); // inserted at beginning
  });

  it("detects moved block with content change", () => {
    const old = [makeBlock("blk_1", "a"), makeBlock("blk_2", "b"), makeBlock("blk_3", "c")];
    const updated = [makeBlock("blk_1", "a"), makeBlock("blk_3", "c updated"), makeBlock("blk_2", "b")];
    const diff = diffBlocks(old, updated);
    // blk_2 is moved (in deleted + added)
    expect(diff.deleted).toContain("blk_2");
    const movedAdd = diff.added.find((a) => a.block.content === "b");
    expect(movedAdd).toBeDefined();
    // blk_3 stays in place but is modified (content changed)
    // Actually — blk_3 might be the one that moves depending on LIS
    // Either way, the moved block's new content is preserved
  });

  it("no reorder when order is preserved", () => {
    const old = [makeBlock("blk_1", "a"), makeBlock("blk_2", "b")];
    const updated = [makeBlock("blk_1", "a changed"), makeBlock("blk_2", "b")];
    const diff = diffBlocks(old, updated);
    expect(diff.deleted).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(1);
  });

  it("handles complete reversal", () => {
    const old = [makeBlock("blk_1", "a"), makeBlock("blk_2", "b"), makeBlock("blk_3", "c")];
    const updated = [makeBlock("blk_3", "c"), makeBlock("blk_2", "b"), makeBlock("blk_1", "a")];
    const diff = diffBlocks(old, updated);
    // At least one block stays in place (LIS length >= 1), rest are moved
    expect(diff.deleted.length).toBeGreaterThanOrEqual(1);
    expect(diff.added.length).toBe(diff.deleted.length);
    // No modifications (content unchanged)
    expect(diff.modified).toHaveLength(0);
  });
});

describe("type token persistence", () => {
  it("parses explicit type token from delimiter", () => {
    const raw = `---blk_1 table---
| H1 | H2 |
| -- | -- |
| a  | b  |
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("table");
    // Type token should NOT appear in styleTokens
    expect(block.styleTokens).not.toContain("table");
  });

  it("type token overrides content heuristic", () => {
    // Content looks like a paragraph, but type token says table
    const raw = `---blk_1 table---
This is not actually table syntax
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("table");
  });

  it("paragraph starting with | is correctly typed when token present", () => {
    // Without type token, this would be misclassified as table
    const raw = `---blk_1 paragraph---
| this is just a paragraph starting with pipe
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("paragraph");
  });

  it("paragraph starting with ![ is correctly typed when token present", () => {
    const raw = `---blk_1 paragraph---
![this is not an image, just text
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("paragraph");
  });

  it("falls back to heuristic when no type token (backward compat)", () => {
    const raw = `---blk_1---
- List item
`;
    const [block] = parseContentString(raw);
    expect(block.type).toBe("list_item");
  });

  it("writeContentFile includes type token for non-paragraph blocks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdsync-test-"));
    const tmpFile = path.join(tmpDir, "content.txt");

    const blocks: Block[] = [
      { blockId: "blk_1", content: "# Title", styleTokens: [], readonly: false, type: "paragraph" },
      { blockId: "blk_2", content: "- Item", styleTokens: [], readonly: false, type: "list_item" },
      { blockId: "blk_3", content: "| A | B |\n| - | - |\n| 1 | 2 |", styleTokens: [], readonly: false, type: "table" },
      { blockId: "blk_4", content: "![alt](assets/img.png)", styleTokens: [], readonly: false, type: "image" },
    ];

    writeContentFile(tmpFile, blocks);
    const written = fs.readFileSync(tmpFile, "utf-8");

    expect(written).toContain("---blk_1 paragraph---");
    expect(written).toContain("---blk_2 list_item---");
    expect(written).toContain("---blk_3 table---");
    expect(written).toContain("---blk_4 image---");

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("roundtrips type correctly through write then parse", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gdsync-test-"));
    const tmpFile = path.join(tmpDir, "content.txt");

    const blocks: Block[] = [
      { blockId: "blk_1", content: "| not a table", styleTokens: [], readonly: false, type: "paragraph" },
      { blockId: "blk_2", content: "regular text", styleTokens: ["text-center"], readonly: false, type: "table" },
    ];

    writeContentFile(tmpFile, blocks);
    const parsed = parseContentString(fs.readFileSync(tmpFile, "utf-8"));

    expect(parsed[0].type).toBe("paragraph"); // not misclassified as table
    expect(parsed[1].type).toBe("table"); // type token overrides heuristic
    expect(parsed[1].styleTokens).toContain("text-center");
    expect(parsed[1].styleTokens).not.toContain("table");

    fs.rmSync(tmpDir, { recursive: true });
  });
});
