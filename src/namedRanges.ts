/**
 * namedRanges.ts — Named range create/delete/lookup helpers.
 *
 * Named ranges are used as position anchors during a sync session.
 * They are created on fetch and deleted on verify/re-fetch.
 */

import { docs_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

type Docs = docs_v1.Docs;

export function getDocsClient(auth: OAuth2Client): Docs {
  return google.docs({ version: "v1", auth });
}

/**
 * Build a batchUpdate request to create a named range.
 */
export function createNamedRangeRequest(
  name: string,
  startIndex: number,
  endIndex: number
): docs_v1.Schema$Request {
  return {
    createNamedRange: {
      name,
      range: { startIndex, endIndex },
    },
  };
}

/**
 * Build a batchUpdate request to delete a named range by name.
 */
export function deleteNamedRangeByNameRequest(name: string): docs_v1.Schema$Request {
  return {
    deleteNamedRange: { name },
  };
}

/**
 * Delete all named ranges matching the blk_* pattern.
 * This is called before creating fresh ranges on each fetch.
 */
export async function deleteAllBlockNamedRanges(
  docs: Docs,
  documentId: string,
  namedRanges: Record<string, docs_v1.Schema$NamedRanges>
): Promise<void> {
  const blkNames = Object.keys(namedRanges).filter((name) => /^blk_\d+$/.test(name));
  if (blkNames.length === 0) return;

  const requests: docs_v1.Schema$Request[] = blkNames.map((name) =>
    deleteNamedRangeByNameRequest(name)
  );

  try {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });
  } catch (err) {
    // Log and continue — stale ranges are not fatal
    console.error(`Warning: failed to delete some named ranges:`, err);
  }
}

/**
 * Create named ranges for all blocks in one batchUpdate call.
 * Returns a map from blockId → namedRangeId (extracted from API response).
 */
export async function createBlockNamedRanges(
  docs: Docs,
  documentId: string,
  blocks: Array<{ blockId: string; startIndex: number; endIndex: number }>
): Promise<Map<string, string>> {
  if (blocks.length === 0) return new Map();

  const requests: docs_v1.Schema$Request[] = blocks.map((b) =>
    createNamedRangeRequest(b.blockId, b.startIndex, b.endIndex)
  );

  const response = await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests },
  });

  const replies = response.data.replies ?? [];
  const idMap = new Map<string, string>();

  blocks.forEach((block, i) => {
    const namedRangeId = replies[i]?.createNamedRange?.namedRangeId;
    if (namedRangeId) {
      idMap.set(block.blockId, namedRangeId);
    }
  });

  return idMap;
}

/**
 * Look up the current range for a named range by ID.
 * Fetches the document to get current positions (handles shifts).
 */
export function lookupNamedRange(
  namedRanges: Record<string, docs_v1.Schema$NamedRanges>,
  blockId: string
): { startIndex: number; endIndex: number } | null {
  const entry = namedRanges[blockId];
  if (!entry?.namedRanges?.[0]?.ranges?.[0]) return null;
  const range = entry.namedRanges[0].ranges[0];
  return {
    startIndex: range.startIndex ?? 0,
    endIndex: range.endIndex ?? 0,
  };
}
