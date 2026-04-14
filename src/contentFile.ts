/**
 * contentFile.ts — Parse and write the content.txt file.
 */

import * as fs from "fs";
import { Block, BlockType } from "./types.js";
import { parseListPrefix } from "./lists.js";

// Matches: ---blk_1--- or ---blk_1 token--- or ---blk_1 tok1 tok2---
const BLOCK_DELIMITER_RE = /^---(blk_\d+)(?:\s+([\w-]+(?:\s+[\w-]+)*))?---$/;
// Matches bare new-block delimiters (no blk_N ID):
//   ---
//   ---paragraph---
//   --- paragraph ---
//   --- paragraph text-center ---
// Must NOT start with blk_ (those are existing block delimiters)
const BARE_DELIMITER_RE = /^---\s*(?!blk_)([\w-]+(?:\s+[\w-]+)*)?\s*---$|^---$/;

// Block type tokens that can appear in delimiters
const BLOCK_TYPE_TOKENS: Set<string> = new Set(["paragraph", "list_item", "table", "image"]);

/**
 * Parse content.txt into an ordered array of Blocks.
 * Throws a descriptive error for malformed delimiters.
 */
export function parseContentFile(filePath: string): Block[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseContentString(raw);
}

export function parseContentString(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];

  let currentBlockId: string | null = null;
  let currentTokens: string[] = [];
  let currentLines: string[] = [];
  let inBlock = false;
  let lineNum = 0;

  function flushBlock(): void {
    if (!inBlock) return;

    // Remove trailing truly empty lines (but preserve whitespace-only lines
    // which represent whitespace paragraphs in the doc)
    while (currentLines.length > 0 && currentLines[currentLines.length - 1] === "") {
      currentLines.pop();
    }

    const content = currentLines.join("\n");
    const readonly = currentTokens.includes("readonly");
    const styleTokens = currentTokens.filter(
      (t) => t !== "readonly" && !BLOCK_TYPE_TOKENS.has(t)
    );

    blocks.push({
      blockId: currentBlockId,
      content,
      styleTokens,
      readonly,
      type: inferBlockType(content, currentTokens),
    });

    currentBlockId = null;
    currentTokens = [];
    currentLines = [];
    inBlock = false;
  }

  for (const line of lines) {
    lineNum++;
    const blockMatch = line.match(BLOCK_DELIMITER_RE);
    const bareMatch = line.match(BARE_DELIMITER_RE);

    if (blockMatch || bareMatch) {
      flushBlock();
      const blockId = blockMatch ? blockMatch[1] : null;
      // Extract tokens from either format
      const tokenStr = blockMatch
        ? (blockMatch[2] ?? "")
        : (bareMatch && bareMatch[1] ? bareMatch[1] : "");
      const tokens = tokenStr ? tokenStr.split(/\s+/).filter(Boolean) : [];
      currentBlockId = blockId;
      currentTokens = tokens;
      currentLines = [];
      inBlock = true;
    } else if (!inBlock) {
      // Lines before the first delimiter — ignore
    } else {
      currentLines.push(line);
    }
  }

  flushBlock();
  return blocks;
}

function inferBlockType(content: string, tokens: string[]): BlockType {
  // Explicit type token takes precedence
  const typeToken = tokens.find((t) => BLOCK_TYPE_TOKENS.has(t));
  if (typeToken) return typeToken as BlockType;

  // Fallback heuristic for backward compatibility and new blocks
  if (tokens.includes("readonly")) {
    if (content.includes("|")) return "table";
  }
  if (content.startsWith("![")) return "image";
  if (content.startsWith("|")) return "table";
  if (parseListPrefix(content)) return "list_item";
  return "paragraph";
}

/**
 * Write blocks to content.txt in the standard format.
 */
export function writeContentFile(
  filePath: string,
  blocks: Block[]
): void {
  const lines: string[] = [];

  for (const block of blocks) {
    const id = block.blockId ?? "";
    const tokens: string[] = [block.type];
    tokens.push(...block.styleTokens);
    if (block.readonly) {
      tokens.push("readonly");
    }
    const tokenStr = tokens.length > 0 ? " " + tokens.join(" ") : "";
    const delimiter = id ? `---${id}${tokenStr}---` : `---${tokenStr}---`;

    lines.push(delimiter);
    lines.push(block.content);
    lines.push(""); // blank line between blocks
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

/**
 * Diff old blocks (from last fetch) against new blocks (current file).
 * Returns classified changes.
 */
export function diffBlocks(
  oldBlocks: Block[],
  newBlocks: Block[]
): {
  modified: Array<{ block: Block; oldBlock: Block }>;
  added: Array<{ block: Block; insertAfterBlockId: string | null }>;
  deleted: string[];
} {
  const oldById = new Map(
    oldBlocks.filter((b) => b.blockId).map((b) => [b.blockId!, b])
  );

  // Build old-order index map for reorder detection
  const oldIndexMap = new Map<string, number>();
  oldBlocks.forEach((b, i) => {
    if (b.blockId) oldIndexMap.set(b.blockId, i);
  });

  // Detect reordered blocks via LIS
  const commonInNewOrder: string[] = [];
  for (const block of newBlocks) {
    if (block.blockId && oldById.has(block.blockId)) {
      commonInNewOrder.push(block.blockId);
    }
  }

  const oldIndicesInNewOrder = commonInNewOrder.map((id) => oldIndexMap.get(id)!);
  const lisPositions = longestIncreasingSubsequence(oldIndicesInNewOrder);
  const inPlaceSet = new Set(lisPositions.map((i) => commonInNewOrder[i]));
  const movedSet = new Set(commonInNewOrder.filter((id) => !inPlaceSet.has(id)));

  const modified: Array<{ block: Block; oldBlock: Block }> = [];
  const added: Array<{ block: Block; insertAfterBlockId: string | null }> = [];
  const deleted: string[] = [];

  // Find the nearest preceding block that's stable (in-place and exists in old)
  function findStableAnchor(beforeIndex: number): string | null {
    for (let j = beforeIndex - 1; j >= 0; j--) {
      const b = newBlocks[j];
      if (b.blockId && oldById.has(b.blockId) && !movedSet.has(b.blockId)) {
        return b.blockId;
      }
    }
    return null;
  }

  // Process blocks in new order
  for (let i = 0; i < newBlocks.length; i++) {
    const block = newBlocks[i];

    if (!block.blockId) {
      // New block
      added.push({
        block,
        insertAfterBlockId: findStableAnchor(i),
      });
    } else if (movedSet.has(block.blockId)) {
      // Moved block — delete from old position, insert at new position
      deleted.push(block.blockId);
      added.push({
        block: { ...block, blockId: null },
        insertAfterBlockId: findStableAnchor(i),
      });
    } else {
      const old = oldById.get(block.blockId);
      if (old) {
        if (old.content !== block.content || !arraysEqual(old.styleTokens, block.styleTokens)) {
          modified.push({ block, oldBlock: old });
        }
      } else {
        // Agent wrote a block ID that didn't exist — treat as new
        added.push({
          block: { ...block, blockId: null },
          insertAfterBlockId: findStableAnchor(i),
        });
      }
    }
  }

  // Find deleted blocks (in old but not in new at all)
  const newIds = new Set(newBlocks.filter((b) => b.blockId).map((b) => b.blockId!));
  for (const old of oldBlocks) {
    if (old.blockId && !newIds.has(old.blockId)) {
      deleted.push(old.blockId);
    }
  }

  return { modified, added, deleted };
}

/**
 * Find indices of the longest increasing subsequence.
 * Returns the positions in the input array that form the LIS.
 */
function longestIncreasingSubsequence(arr: number[]): number[] {
  if (arr.length === 0) return [];

  const n = arr.length;
  const dp = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);

  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (arr[j] < arr[i] && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        prev[i] = j;
      }
    }
  }

  let maxIdx = 0;
  for (let i = 1; i < n; i++) {
    if (dp[i] > dp[maxIdx]) maxIdx = i;
  }

  const result: number[] = [];
  let idx: number = maxIdx;
  while (idx !== -1) {
    result.push(idx);
    idx = prev[idx];
  }

  return result.reverse();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Parse image references from blocks.
 * Returns array of { blockId, localPath } for image blocks.
 */
export function extractImageRefs(blocks: Block[]): Array<{ blockId: string | null; localPath: string }> {
  const refs: Array<{ blockId: string | null; localPath: string }> = [];
  const imageRe = /!\[.*?\]\((assets\/[^)]+)\)/;
  for (const block of blocks) {
    if (block.type === "image") {
      const m = block.content.match(imageRe);
      if (m) {
        refs.push({ blockId: block.blockId, localPath: m[1] });
      }
    }
  }
  return refs;
}
