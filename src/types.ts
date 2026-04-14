export type BlockType = "paragraph" | "list_item" | "table" | "image";

export type Block = {
  blockId: string | null; // null if new
  content: string;
  styleTokens: string[];
  readonly: boolean;
  type: BlockType;
};

export type BlockMapEntry = {
  blockId: string;
  namedRangeId: string;
  namedRangeName: string;
  startIndex: number;
  endIndex: number;
  type: BlockType;
  listId?: string;
  nestingLevel?: number;
  inlineObjectId?: string;
};

export type BlockMap = Map<string, BlockMapEntry>;

export type SyncMode = "auto" | "suggestions";

export type Config = {
  documentId: string;
  documentTitle: string;
  mode: SyncMode;
  commentFilter?: boolean;
};

// Session state held in memory for the duration of a fetch→commit cycle
export type SessionState = {
  config: Config;
  blockMap: BlockMap;
  // The raw block list as parsed after the last fetch (used for diffing)
  fetchedBlocks: Block[];
  fetchedAt: Date;
};
