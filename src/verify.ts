/**
 * verify.ts — Phase 4: Re-fetch, rebuild content.txt, validate against committed state.
 */

import { OAuth2Client } from "google-auth-library";
import { fetchDocument } from "./fetch.js";
import { SessionState } from "./types.js";
import { Block } from "./types.js";
import { canonicalizeTableContent } from "./tables.js";

export type VerifyResult = {
  success: boolean;
  diff: Array<{ blockId: string; expected: string; got: string }>;
  newSession: SessionState;
};

/**
 * Re-fetch the document and compare to what was committed.
 * Always rewrites content.txt with the fresh state.
 * Returns success=true if they match, false + diff if not.
 */
export async function verifyDocument(
  auth: OAuth2Client,
  documentId: string,
  workDir: string,
  committedBlocks: Block[],
  session: SessionState,
  mentionFilter?: { email: string; name: string }
): Promise<VerifyResult> {
  // Re-fetch to get current state
  const { title, blockCount, blocks: freshBlocks, blockMap } = await fetchDocument(
    auth,
    documentId,
    workDir,
    mentionFilter
  );

  // Build new session state
  const newSession: SessionState = {
    config: session.config,
    blockMap,
    fetchedBlocks: freshBlocks,
    fetchedAt: new Date(),
  };

  // Compare committed content against fresh content
  // Match by position (index), since block IDs are reassigned
  const diff: Array<{ blockId: string; expected: string; got: string }> = [];

  const len = Math.min(committedBlocks.length, freshBlocks.length);
  for (let i = 0; i < len; i++) {
    // Tables are compared by canonical form so lenient agent input (missing
    // separator, uneven columns, spacing) that gdsync normalizes on render
    // doesn't read as a mismatch.
    const isTable =
      committedBlocks[i].type === "table" || freshBlocks[i].type === "table";
    const expected = isTable
      ? canonicalizeTableContent(committedBlocks[i].content)
      : committedBlocks[i].content.trim();
    const got = isTable
      ? canonicalizeTableContent(freshBlocks[i].content)
      : freshBlocks[i].content.trim();
    if (expected !== got) {
      diff.push({
        blockId: freshBlocks[i].blockId ?? `blk_${i + 1}`,
        expected,
        got,
      });
    }
  }

  if (committedBlocks.length !== freshBlocks.length) {
    diff.push({
      blockId: "document",
      expected: `${committedBlocks.length} blocks`,
      got: `${freshBlocks.length} blocks`,
    });
  }

  return {
    success: diff.length === 0,
    diff,
    newSession,
  };
}
