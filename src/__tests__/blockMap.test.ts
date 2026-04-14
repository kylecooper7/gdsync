import { describe, it, expect } from "vitest";
import {
  createBlockMap,
  getEntry,
  setEntry,
  allEntries,
  entriesInDocOrder,
  entriesInReverseDocOrder,
} from "../blockMap.js";
import { BlockMapEntry } from "../types.js";

function makeEntry(blockId: string, startIndex: number, endIndex: number): BlockMapEntry {
  return {
    blockId,
    namedRangeId: `nr_${blockId}`,
    namedRangeName: blockId,
    startIndex,
    endIndex,
    type: "paragraph",
  };
}

describe("blockMap", () => {
  it("creates an empty map", () => {
    const map = createBlockMap();
    expect(allEntries(map)).toHaveLength(0);
  });

  it("stores and retrieves entries", () => {
    const map = createBlockMap();
    const entry = makeEntry("blk_1", 1, 45);
    setEntry(map, entry);
    expect(getEntry(map, "blk_1")).toEqual(entry);
  });

  it("returns undefined for missing entry", () => {
    const map = createBlockMap();
    expect(getEntry(map, "blk_99")).toBeUndefined();
  });

  it("returns entries in document order", () => {
    const map = createBlockMap();
    setEntry(map, makeEntry("blk_3", 90, 120));
    setEntry(map, makeEntry("blk_1", 1, 45));
    setEntry(map, makeEntry("blk_2", 45, 90));

    const ordered = entriesInDocOrder(map);
    expect(ordered[0].blockId).toBe("blk_1");
    expect(ordered[1].blockId).toBe("blk_2");
    expect(ordered[2].blockId).toBe("blk_3");
  });

  it("returns entries in reverse document order", () => {
    const map = createBlockMap();
    setEntry(map, makeEntry("blk_1", 1, 45));
    setEntry(map, makeEntry("blk_2", 45, 90));
    setEntry(map, makeEntry("blk_3", 90, 120));

    const reversed = entriesInReverseDocOrder(map);
    expect(reversed[0].blockId).toBe("blk_3");
    expect(reversed[2].blockId).toBe("blk_1");
  });
});
