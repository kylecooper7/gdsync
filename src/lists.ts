/**
 * lists.ts — List detection, prefix handling, and nesting.
 */

export type ListInfo = {
  isOrdered: boolean;
  nestingLevel: number;
};

/**
 * Parse list info from a content block's text.
 * Returns null if the block is not a list item.
 */
export function parseListPrefix(content: string): ListInfo | null {
  // Count leading spaces to determine nesting level (2 spaces per level)
  const indentMatch = content.match(/^( *)/);
  const indent = indentMatch ? indentMatch[1].length : 0;
  const nestingLevel = Math.min(Math.floor(indent / 2), 2);
  const trimmed = content.slice(indent);

  if (/^- /.test(trimmed)) {
    return { isOrdered: false, nestingLevel };
  }
  if (/^\d+\. /.test(trimmed)) {
    return { isOrdered: true, nestingLevel };
  }
  return null;
}

/**
 * Strip the list prefix (including leading indent) from content text.
 */
export function stripListPrefix(content: string): string {
  return content.replace(/^( *)(- |\d+\. )/, "");
}

/**
 * Prefix text with the appropriate number of tab characters for nesting.
 * The Docs API uses leading tabs to determine bullet nesting level.
 */
export function addNestingTabs(text: string, nestingLevel: number): string {
  if (nestingLevel <= 0) return text;
  return "\t".repeat(nestingLevel) + text;
}
