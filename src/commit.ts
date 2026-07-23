/**
 * commit.ts — Phase 3: Diff content.txt, build batchUpdate requests, send to Docs API.
 */

import * as path from "path";
import { docs_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { parseContentFile, diffBlocks, extractImageRefs } from "./contentFile.js";
import {
  buildDeleteRequests,
  buildModifyRequests,
  buildInsertRequests,
  prepareTextAndStyles,
  namedStyleType,
  alignmentValue,
} from "./deserialize.js";
import { getDocsClient, lookupNamedRange } from "./namedRanges.js";
import { checkImageFiles, uploadImageToDrive, deleteDriveFile } from "./images.js";
import { parseMarkdownTable, diffTables, validateTableDimensions, buildTableCellUpdateRequests, insertTableRequest, allCellsAsChanges } from "./tables.js";
import { Block, BlockMapEntry, SessionState, SyncMode } from "./types.js";

export type CommitResult = {
  modified: number;
  added: number;
  deleted: number;
};

/**
 * Commit edits from content.txt to the Google Doc.
 */
export async function commitDocument(
  auth: OAuth2Client,
  documentId: string,
  workDir: string,
  session: SessionState,
  mode: SyncMode
): Promise<CommitResult> {
  const docs = getDocsClient(auth);
  const contentPath = path.join(workDir, "content.txt");
  const isSuggestionsMode = mode === "suggestions";

  // 1. Read current content.txt
  const currentBlocks = parseContentFile(contentPath);

  // 2. Diff against last fetch state
  const { modified, added, deleted } = diffBlocks(session.fetchedBlocks, currentBlocks);

  if (modified.length === 0 && added.length === 0 && deleted.length === 0) {
    return { modified: 0, added: 0, deleted: 0 };
  }

  // 3. Validate image files exist before any API calls
  const imageRefs = extractImageRefs(currentBlocks);
  const missingImages = checkImageFiles(
    imageRefs
      .filter((r) => !/^https?:\/\//i.test(r.localPath)) // remote URLs need no local file
      .map((r) => ({
        blockId: r.blockId,
        localPath: path.join(workDir, r.localPath),
      }))
  );

  if (missingImages.length > 0) {
    const first = missingImages[0];
    const blockStr = first.blockId ?? "new block";
    throw Object.assign(
      new Error(
        `Sync error: Image not found at ${first.localPath} — block ${blockStr} not synced`
      ),
      { exitCode: 6 }
    );
  }

  // 4. Validate table dimensions for modified table blocks
  for (const { block, oldBlock } of modified) {
    if (block.type === "table" && !block.readonly) {
      const oldParsed = parseMarkdownTable(oldBlock.content);
      const newParsed = parseMarkdownTable(block.content);
      const err = validateTableDimensions(oldParsed, newParsed, block.blockId);
      if (err) {
        throw Object.assign(new Error(err), { exitCode: 4 });
      }
    }
  }

  // Re-fetch doc to get current named range positions
  const freshDoc = await (docs.documents.get({ documentId }) as unknown as Promise<{ data: docs_v1.Schema$Document }>);
  const freshNamedRanges = (freshDoc.data.namedRanges ?? {}) as Record<string, docs_v1.Schema$NamedRanges>;

  // True document body end from the raw doc (not the block map, which omits the
  // mandatory empty paragraph after a trailing table). Inserts must land before it.
  const freshBodyEls = freshDoc.data.body?.content ?? [];
  const docBodyEnd = freshBodyEls.length
    ? freshBodyEls[freshBodyEls.length - 1].endIndex ?? 1
    : 1;

  // Update block map entries with fresh positions
  const refreshedMap = new Map<string, BlockMapEntry>(session.blockMap);
  for (const [blockId, entry] of refreshedMap.entries()) {
    const freshRange = lookupNamedRange(freshNamedRanges, blockId);
    if (freshRange) {
      refreshedMap.set(blockId, {
        ...entry,
        startIndex: freshRange.startIndex,
        endIndex: freshRange.endIndex,
      });
    }
  }

  const deletedEntries = deleted
    .map((id) => refreshedMap.get(id))
    .filter((e): e is BlockMapEntry => !!e)
    .sort((a, b) => b.startIndex - a.startIndex);

  // Red color for suggestion-mode new text
  const SUGGEST_RED = {
    foregroundColor: { color: { rgbColor: { red: 0.85, green: 0.15, blue: 0.15 } } },
  };

  let allRequests: docs_v1.Schema$Request[];
  const newTableContents: string[] = [];
  // Drive files backing inserted images — deleted only AFTER the batchUpdate
  // embeds them, so the image isn't gone before Docs fetches it.
  const driveFileIdsToDelete: string[] = [];

  if (isSuggestionsMode) {
    // -----------------------------------------------------------------------
    // Suggestions mode: strikethrough old/deleted, red for new/replacement
    // -----------------------------------------------------------------------
    const reqs: docs_v1.Schema$Request[] = [];

    // Deletions: apply strikethrough instead of deleting (reverse doc order)
    for (const entry of deletedEntries) {
      if (entry.startIndex < entry.endIndex - 1) {
        reqs.push({
          updateTextStyle: {
            range: { startIndex: entry.startIndex, endIndex: entry.endIndex - 1 },
            textStyle: { strikethrough: true },
            fields: "strikethrough",
          },
        });
      }
    }

    // Modifications: strikethrough old block + insert new red paragraph after it
    // Process in reverse doc order so inserts don't shift earlier positions
    const modEntries = modified
      .filter((m) => !m.block.readonly && m.block.blockId)
      .map((m) => ({ ...m, entry: refreshedMap.get(m.block.blockId!)! }))
      .filter((m) => m.entry)
      .sort((a, b) => b.entry.startIndex - a.entry.startIndex);

    // Track shifts from modification inserts (for additions later)
    const modShifts: Array<{ position: number; shift: number }> = [];

    // Collect strikethrough requests (applied first, before any inserts)
    const strikethroughReqs: docs_v1.Schema$Request[] = [];
    // Collect insert + style requests (applied after strikethrough)
    const insertStyleReqs: docs_v1.Schema$Request[] = [];

    for (const { block, entry } of modEntries) {
      // Tables/images: apply directly (no visual suggestion)
      if (block.type === "table") {
        const oldParsed = parseMarkdownTable(block.content);
        const newParsed = parseMarkdownTable(block.content);
        const changes = diffTables(oldParsed, newParsed);
        if (changes.length > 0) {
          const docTable = findTableAtIndex(freshDoc.data, entry.startIndex);
          if (docTable) insertStyleReqs.push(...buildTableCellUpdateRequests(docTable, changes).requests);
        }
        continue;
      }
      if (block.type === "image") continue;

      // Strikethrough old text (goes in first batch)
      if (entry.startIndex < entry.endIndex - 1) {
        strikethroughReqs.push({
          updateTextStyle: {
            range: { startIndex: entry.startIndex, endIndex: entry.endIndex - 1 },
            textStyle: { strikethrough: true },
            fields: "strikethrough",
          },
        });
      }

      // Insert new paragraph after old block
      const { insertText: text, styleRequests } = prepareTextAndStyles(block, entry.endIndex);
      if (text) {
        // Create new paragraph + insert text
        insertStyleReqs.push({
          insertText: { location: { index: entry.endIndex }, text: "\n" },
        });
        insertStyleReqs.push({
          insertText: { location: { index: entry.endIndex }, text },
        });

        const insertedLen = text.length + 1;

        // Set paragraph style on new paragraph
        insertStyleReqs.push({
          updateParagraphStyle: {
            range: { startIndex: entry.endIndex, endIndex: entry.endIndex + insertedLen },
            paragraphStyle: { namedStyleType: namedStyleType(block.content) },
            fields: "namedStyleType",
          },
        });

        // Red color on new text
        insertStyleReqs.push({
          updateTextStyle: {
            range: { startIndex: entry.endIndex, endIndex: entry.endIndex + text.length },
            textStyle: SUGGEST_RED,
            fields: "foregroundColor",
          },
        });

        // Apply inline styles (bold, italic, etc.)
        insertStyleReqs.push(...styleRequests);

        modShifts.push({ position: entry.endIndex, shift: insertedLen });
      }
    }

    // Strikethrough first, then inserts + styling
    reqs.push(...strikethroughReqs, ...insertStyleReqs);

    // Additions: insert normally + apply red color
    const docContentEnd = docBodyEnd;
    const tableStarts = new Set(
      [...refreshedMap.values()].filter((e) => e.type === "table").map((e) => e.startIndex)
    );
    let indexShift = 0;
    for (const { block, insertAfterBlockId } of added) {
      let insertIndex: number;
      let atBoundary = false;
      if (insertAfterBlockId) {
        const prevEntry = refreshedMap.get(insertAfterBlockId);
        const rawEndIndex = prevEntry?.endIndex ?? 1;
        // Inserting text at the body end or a table start is invalid — insert at
        // endIndex - 1 and place content after the newline (see auto mode).
        atBoundary = rawEndIndex >= docContentEnd || tableStarts.has(rawEndIndex);
        insertIndex = (atBoundary ? rawEndIndex - 1 : rawEndIndex) + indexShift;
      } else {
        insertIndex = 1 + indexShift;
      }

      // Account for shifts from modification inserts
      for (const ms of modShifts) {
        if (ms.position <= insertIndex) {
          insertIndex += ms.shift;
        }
      }

      if (block.type === "image" || block.type === "table") {
        // Insert directly (same as auto mode)
        if (block.type === "table") {
          const parsed = parseMarkdownTable(block.content);
          const rows = parsed.rows.length + 1;
          const cols = parsed.headers.length;
          reqs.push(insertTableRequest(rows, cols, insertIndex));
          newTableContents.push(block.content);
          indexShift += rows * cols + rows + 1;
        }
        // Image handling omitted for brevity — same as auto mode
      } else {
        const { requests: insertReqs, insertedLength } = buildInsertRequests(block, insertIndex, atBoundary);
        reqs.push(...insertReqs);

        // Red color on the inserted text (skip the \n, color the text). When
        // atBoundary, the content sits after the inserted newline.
        const textStart = atBoundary ? insertIndex + 1 : insertIndex;
        const textLen = insertedLength - 1; // subtract the \n
        if (textLen > 0) {
          reqs.push({
            updateTextStyle: {
              range: { startIndex: textStart, endIndex: textStart + textLen },
              textStyle: SUGGEST_RED,
              fields: "foregroundColor",
            },
          });
        }

        indexShift += insertedLength;
      }
    }

    allRequests = reqs;
  } else {
    // -----------------------------------------------------------------------
    // Auto mode: direct edits
    // All deletions and modifications are sorted by startIndex DESCENDING
    // so each operation only shifts content AFTER its position (already processed).
    // -----------------------------------------------------------------------
    type BlockOp =
      | { kind: "delete"; entry: BlockMapEntry }
      | { kind: "modify"; block: Block; oldBlock: Block; entry: BlockMapEntry };

    const ops: BlockOp[] = [];

    for (const entry of deletedEntries) {
      ops.push({ kind: "delete", entry });
    }

    for (const { block, oldBlock } of modified) {
      if (block.readonly || !block.blockId) continue;
      const entry = refreshedMap.get(block.blockId);
      if (!entry) continue;
      ops.push({ kind: "modify", block, oldBlock, entry });
    }

    // Sort by startIndex descending — process highest position first
    ops.sort((a, b) => b.entry.startIndex - a.entry.startIndex);

    const editRequests: docs_v1.Schema$Request[] = [];
    // Track position deltas for adjusting insertion indices later
    const positionDeltas: Array<{ position: number; delta: number }> = [];

    for (const op of ops) {
      if (op.kind === "delete") {
        const isLastBlock = op.entry.endIndex >= docBodyEnd;
        editRequests.push(...buildDeleteRequests(op.entry, isLastBlock));
        const deletedEnd = isLastBlock ? op.entry.endIndex - 1 : op.entry.endIndex;
        positionDeltas.push({
          position: op.entry.startIndex,
          delta: -(deletedEnd - op.entry.startIndex),
        });
      } else {
        const { block, oldBlock, entry } = op;
        if (block.type === "table") {
          const oldParsed = parseMarkdownTable(oldBlock.content);
          const newParsed = parseMarkdownTable(block.content);
          const changes = diffTables(oldParsed, newParsed);
          if (changes.length > 0) {
            const docTable = findTableAtIndex(freshDoc.data, entry.startIndex);
            if (docTable) {
              const { requests: tableReqs, netDelta } = buildTableCellUpdateRequests(docTable, changes);
              editRequests.push(...tableReqs);
              // Cell text-length changes shift everything after the table — record
              // the delta so inserts after the table use correct indices.
              if (netDelta !== 0) {
                positionDeltas.push({ position: entry.startIndex, delta: netDelta });
              }
            }
          }
        } else if (block.type === "image") {
          // Skip changed image blocks for now
        } else {
          editRequests.push(...buildModifyRequests(block, entry));
          // Compute the new paragraph length vs old
          const { insertText: text } = prepareTextAndStyles(block, entry.startIndex);
          const newParaLen = (text?.length ?? 0) + 1; // text + \n
          const oldParaLen = entry.endIndex - entry.startIndex;
          positionDeltas.push({
            position: entry.startIndex,
            delta: newParaLen - oldParaLen,
          });
        }
      }
    }

    // Compute cumulative shift at a given position from all ops before it
    function cumulativeShiftAt(pos: number): number {
      let shift = 0;
      for (const d of positionDeltas) {
        if (d.position < pos) shift += d.delta;
      }
      return shift;
    }

    // Insertions: adjust indices by cumulative shift from deletions/modifications
    const insertRequests: docs_v1.Schema$Request[] = [];
    // Body content end — inserts must land strictly before this index (Google
    // Docs rejects an index at/after the body's terminal newline).
    const docContentEnd = docBodyEnd;
    // Table start positions. Inserting text AT a table boundary is invalid, so
    // an insert landing there is handled like an end-of-doc insert.
    const tableStarts = new Set(
      [...refreshedMap.values()].filter((e) => e.type === "table").map((e) => e.startIndex)
    );
    let indexShift = 0;
    for (const { block, insertAfterBlockId } of added) {
      let insertIndex: number;
      let atBoundary = false;
      if (insertAfterBlockId) {
        const prevEntry = refreshedMap.get(insertAfterBlockId);
        const rawEndIndex = prevEntry?.endIndex ?? 1;
        // The anchor's endIndex is not a valid text-insertion point when it is
        // the body end or the start of a table. In those cases insert at
        // endIndex - 1 and let buildInsertRequests place content after the newline.
        atBoundary = rawEndIndex >= docContentEnd || tableStarts.has(rawEndIndex);
        const base = atBoundary ? rawEndIndex - 1 : rawEndIndex;
        insertIndex = base + cumulativeShiftAt(rawEndIndex) + indexShift;
      } else {
        insertIndex = 1 + cumulativeShiftAt(1) + indexShift;
      }

      if (block.type === "image") {
        const imageRef = extractImageRefs([block])[0];
        if (imageRef) {
          const isRemote = /^https?:\/\//i.test(imageRef.localPath);
          let uri: string;
          if (isRemote) {
            // Insert directly from a public URL — no Drive round-trip needed.
            uri = imageRef.localPath;
          } else {
            try {
              const { driveFileId, publicUrl } = await uploadImageToDrive(
                auth,
                path.join(workDir, imageRef.localPath)
              );
              uri = publicUrl;
              // Delete AFTER the batchUpdate embeds the image (not before).
              driveFileIdsToDelete.push(driveFileId);
            } catch (err) {
              throw Object.assign(
                new Error(`Failed to upload image ${imageRef.localPath}: ${(err as Error).message}`),
                { exitCode: 4 }
              );
            }
          }
          // Give the image its own paragraph (a newline), then place the image.
          // When at the document/table boundary, put the image after the newline.
          const imgIndex = atBoundary ? insertIndex + 1 : insertIndex;
          insertRequests.push({
            insertText: { location: { index: insertIndex }, text: "\n" },
          });
          insertRequests.push({
            insertInlineImage: {
              location: { index: imgIndex },
              uri,
              objectSize: { width: { magnitude: 180, unit: "PT" } },
            },
          });
          // Apply paragraph alignment (e.g. text-center) to the image's paragraph.
          const alignToken = block.styleTokens.find((t) => t.startsWith("text-"));
          const alignment = alignToken ? alignmentValue(alignToken) : null;
          if (alignment) {
            insertRequests.push({
              updateParagraphStyle: {
                range: { startIndex: imgIndex, endIndex: imgIndex + 1 },
                paragraphStyle: { alignment },
                fields: "alignment",
              },
            });
          }
          indexShift += 2; // newline + image
        }
      } else if (block.type === "table") {
        const parsed = parseMarkdownTable(block.content);
        const rows = parsed.rows.length + 1;
        const cols = parsed.headers.length;
        insertRequests.push(insertTableRequest(rows, cols, insertIndex));
        newTableContents.push(block.content);
        indexShift += rows * cols + rows + 1;
      } else {
        const { requests: reqs, insertedLength } = buildInsertRequests(block, insertIndex, atBoundary);
        insertRequests.push(...reqs);
        indexShift += insertedLength;
      }
    }

    allRequests = [...editRequests, ...insertRequests];
  }

  // 6. Send all requests in one batchUpdate
  if (allRequests.length > 0) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: allRequests },
    });
  }

  // Now that images are embedded, clean up their temporary Drive files.
  for (const fileId of driveFileIdsToDelete) {
    deleteDriveFile(auth, fileId).catch(() => {});
  }

  // 7. Fill newly inserted tables with cell content
  // insertTable creates empty cells — we need a second batchUpdate after the table
  // exists in the document so we can address cell indexes.
  if (newTableContents.length > 0) {
    const docAfterInsert = await (docs.documents.get({ documentId }) as unknown as Promise<{ data: docs_v1.Schema$Document }>);
    const bodyContent = docAfterInsert.data.body?.content ?? [];

    // Find empty tables (newly created — all cells contain only whitespace)
    const emptyDocTables: docs_v1.Schema$Table[] = [];
    for (const el of bodyContent) {
      if (el.table && isTableEmpty(el.table)) {
        emptyDocTables.push(el.table);
      }
    }

    const fillRequests: docs_v1.Schema$Request[] = [];
    const count = Math.min(emptyDocTables.length, newTableContents.length);
    for (let i = 0; i < count; i++) {
      const parsed = parseMarkdownTable(newTableContents[i]);
      const changes = allCellsAsChanges(parsed);
      if (changes.length > 0) {
        fillRequests.push(...buildTableCellUpdateRequests(emptyDocTables[i], changes).requests);
      }
    }

    if (fillRequests.length > 0) {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: fillRequests },
      });
    }
  }

  return {
    modified: modified.length,
    added: added.length,
    deleted: deleted.length,
  };
}

/**
 * Find the table structural element closest to the given startIndex.
 */
function findTableAtIndex(
  doc: docs_v1.Schema$Document,
  startIndex: number
): docs_v1.Schema$Table | null {
  const content = doc.body?.content ?? [];
  for (const el of content) {
    if (el.table && el.startIndex === startIndex) {
      return el.table;
    }
  }
  return null;
}

/**
 * Check if a table has all empty cells (only whitespace/newlines).
 * Newly inserted tables via insertTable have empty cells.
 */
function isTableEmpty(table: docs_v1.Schema$Table): boolean {
  for (const row of table.tableRows ?? []) {
    for (const cell of row.tableCells ?? []) {
      for (const el of cell.content ?? []) {
        if (el.paragraph) {
          const text = el.paragraph.elements
            ?.map((e) => e.textRun?.content ?? "")
            .join("") ?? "";
          if (text.replace(/\n/g, "").trim() !== "") {
            return false;
          }
        }
      }
    }
  }
  return true;
}
