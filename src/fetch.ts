/**
 * fetch.ts — Phase 1: Fetch document, serialize, write content.txt, build block map.
 */

import * as path from "path";
import * as fs from "fs";
import { docs_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import {
  serializeParagraph,
  serializeTable,
  DocParagraph,
  DocTable,
  ListsMap,
} from "./serialize.js";
import { writeContentFile } from "./contentFile.js";
import {
  createBlockMap,
  setEntry,
} from "./blockMap.js";
import {
  getDocsClient,
  deleteAllBlockNamedRanges,
  createBlockNamedRanges,
} from "./namedRanges.js";
import { downloadImage } from "./images.js";
import { Block, BlockMap, BlockMapEntry, BlockType } from "./types.js";
import { refreshCommentsFile } from "./comments.js";

export type FetchResult = {
  title: string;
  blockCount: number;
  blocks: Block[];
  blockMap: BlockMap;
};

/**
 * Fetch the Google Doc and write content.txt + assets/.
 * Returns the block list and block map for in-memory session state.
 */
export async function fetchDocument(
  auth: OAuth2Client,
  documentId: string,
  workDir: string,
  mentionFilter?: { email: string; name: string }
): Promise<FetchResult> {
  const docs = getDocsClient(auth);

  // 1. Fetch the full document
  const docResponse = await (docs.documents.get({ documentId }) as unknown as Promise<{ data: docs_v1.Schema$Document }>);
  const doc = docResponse.data;

  const title = doc.title ?? "Untitled";
  const bodyContent = doc.body?.content ?? [];
  const inlineObjects = (doc.inlineObjects ?? {}) as Record<string, docs_v1.Schema$InlineObject>;
  const lists = (doc.lists ?? {}) as ListsMap;
  const namedRanges = (doc.namedRanges ?? {}) as Record<string, docs_v1.Schema$NamedRanges>;

  // 2. Delete all existing blk_* named ranges for a clean slate
  await deleteAllBlockNamedRanges(docs, documentId, namedRanges);

  // 3. Set up assets directory
  const assetsDir = path.join(workDir, "assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  // Track image counter separately to handle sequential naming
  let imgCounter = 0;
  const inlineObjectLocalPaths = new Map<string, string>();

  // Image resolver: download the image if not yet done, return local path
  const imageResolver = (inlineObjectId: string): string => {
    if (inlineObjectLocalPaths.has(inlineObjectId)) {
      return inlineObjectLocalPaths.get(inlineObjectId)!;
    }
    imgCounter++;
    const ext = "png"; // will be overwritten after download
    const localPath = `assets/img_${String(imgCounter).padStart(3, "0")}.${ext}`;
    inlineObjectLocalPaths.set(inlineObjectId, localPath);
    return localPath;
  };

  const altTextResolver = (inlineObjectId: string): string => {
    const obj = inlineObjects[inlineObjectId];
    return obj?.inlineObjectProperties?.embeddedObject?.title ?? "image";
  };

  // 4. Parse all structural elements
  const rawBlocks: Array<{
    content: string;
    styleToken: string | null;
    readonly: boolean;
    type: BlockType;
    startIndex: number;
    endIndex: number;
    listId?: string;
    nestingLevel?: number;
    inlineObjectId?: string;
  }> = [];

  for (const element of bodyContent) {
    if (element.paragraph) {
      const para = element.paragraph as DocParagraph;
      const startIndex = element.startIndex ?? 0;
      const endIndex = element.endIndex ?? 0;

      // Check for inline object (image)
      const inlineEl = para.elements?.find((el) => el.inlineObjectElement);

      const { content, styleToken, isListItem, isImage } = serializeParagraph(
        para,
        lists,
        imageResolver,
        altTextResolver
      );

      if (!content && !isImage) continue; // skip empty paragraphs silently? actually keep them per spec

      const type: BlockType = isImage
        ? "image"
        : isListItem
          ? "list_item"
          : "paragraph";

      rawBlocks.push({
        content: content || "", // empty paragraph is valid
        styleToken,
        readonly: false,
        type,
        startIndex,
        endIndex,
        listId: para.bullet?.listId,
        nestingLevel: para.bullet?.nestingLevel,
        inlineObjectId: inlineEl?.inlineObjectElement?.inlineObjectId,
      });
    } else if (element.table) {
      const table = element.table as DocTable;
      const startIndex = element.startIndex ?? 0;
      const endIndex = element.endIndex ?? 0;
      const { content, isComplex } = serializeTable(table);

      rawBlocks.push({
        content,
        styleToken: null,
        readonly: isComplex,
        type: "table",
        startIndex,
        endIndex,
      });
    }
    // sectionBreak and tableOfContents are skipped
  }

  // 5. Download images concurrently
  const downloadPromises: Promise<void>[] = [];
  for (const [inlineObjectId, localRelPath] of inlineObjectLocalPaths.entries()) {
    const obj = inlineObjects[inlineObjectId];
    const contentUri = obj?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
    if (!contentUri) {
      console.warn(`Warning: no contentUri for image ${inlineObjectId}`);
      continue;
    }

    const localAbsPath = path.join(workDir, localRelPath);
    downloadPromises.push(
      downloadImage(contentUri, localAbsPath).then((ok) => {
        if (!ok) {
          // Rename to MISSING_ prefix to signal failure
          const dir = path.dirname(localRelPath);
          const base = path.basename(localRelPath);
          const missingPath = `${dir}/MISSING_${base}`;
          // Update the mapping
          inlineObjectLocalPaths.set(inlineObjectId, missingPath);
          console.warn(`Warning: image download failed for ${inlineObjectId}, saved as ${missingPath}`);
        }
      })
    );
  }
  await Promise.all(downloadPromises);

  // Update content for image blocks with corrected paths (after MISSING_ rename)
  for (const raw of rawBlocks) {
    if (raw.type === "image" && raw.inlineObjectId) {
      const localPath = inlineObjectLocalPaths.get(raw.inlineObjectId);
      if (localPath) {
        const altText = altTextResolver(raw.inlineObjectId);
        raw.content = `![${altText}](${localPath})`;
      }
    }
  }

  // 6. Assign sequential block IDs and build Block objects
  const blocks: Block[] = rawBlocks.map((raw, i) => ({
    blockId: `blk_${i + 1}`,
    content: raw.content,
    styleTokens: raw.styleToken ? [raw.styleToken] : [],
    readonly: raw.readonly,
    type: raw.type,
  }));

  // 7. Write content.txt
  const contentPath = path.join(workDir, "content.txt");
  writeContentFile(contentPath, blocks);

  // 8. Create named ranges for each block
  const rangeInputs = rawBlocks.map((raw, i) => ({
    blockId: `blk_${i + 1}`,
    startIndex: raw.startIndex,
    endIndex: raw.endIndex,
  }));
  const namedRangeIds = await createBlockNamedRanges(docs, documentId, rangeInputs);

  // 9. Build block map
  const blockMap = createBlockMap();
  rawBlocks.forEach((raw, i) => {
    const blockId = `blk_${i + 1}`;
    const namedRangeId = namedRangeIds.get(blockId) ?? "";
    const entry: BlockMapEntry = {
      blockId,
      namedRangeId,
      namedRangeName: blockId,
      startIndex: raw.startIndex,
      endIndex: raw.endIndex,
      type: raw.type,
      listId: raw.listId,
      nestingLevel: raw.nestingLevel,
      inlineObjectId: raw.inlineObjectId,
    };
    setEntry(blockMap, entry);
  });

  // 10. Fetch comments and write comments.txt
  await refreshCommentsFile(auth, documentId, workDir, blockMap, false, mentionFilter);

  return { title, blockCount: blocks.length, blocks, blockMap };
}
