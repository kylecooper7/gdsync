/**
 * blockMap.ts — In-memory block map management.
 * The block map is built during fetch and held until verify completes.
 */

import { BlockMap, BlockMapEntry } from "./types.js";

export function createBlockMap(): BlockMap {
  return new Map<string, BlockMapEntry>();
}

export function getEntry(map: BlockMap, blockId: string): BlockMapEntry | undefined {
  return map.get(blockId);
}

export function setEntry(map: BlockMap, entry: BlockMapEntry): void {
  map.set(entry.blockId, entry);
}

export function allEntries(map: BlockMap): BlockMapEntry[] {
  return Array.from(map.values());
}

/**
 * Return entries sorted by startIndex (document order).
 */
export function entriesInDocOrder(map: BlockMap): BlockMapEntry[] {
  return Array.from(map.values()).sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Return entries sorted by startIndex descending (reverse document order).
 * Used when processing deletions.
 */
export function entriesInReverseDocOrder(map: BlockMap): BlockMapEntry[] {
  return Array.from(map.values()).sort((a, b) => b.startIndex - a.startIndex);
}
