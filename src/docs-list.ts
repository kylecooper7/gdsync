/**
 * docs-list.ts — List Google Docs accessible to the authenticated user.
 */

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export type DocInfo = {
  id: string;
  name: string;
  modifiedTime: string;
  modifiedTimeRelative: string;
  owner: string;
  shared: boolean;
};

/**
 * List Google Docs the user has access to, including shared docs.
 * Sorted by most recently modified.
 */
export async function listDocs(
  auth: OAuth2Client,
  options: { search?: string; limit?: number } = {}
): Promise<DocInfo[]> {
  const drive = google.drive({ version: "v3", auth });
  const limit = options.limit ?? 20;

  // Build query: only Google Docs, optionally filter by name
  let query = "mimeType='application/vnd.google-apps.document' and trashed=false";
  if (options.search) {
    query += ` and name contains '${options.search.replace(/'/g, "\\'")}'`;
  }

  const allDocs: DocInfo[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: query,
      fields: "files(id,name,modifiedTime,owners,shared),nextPageToken",
      orderBy: "modifiedTime desc",
      pageSize: Math.min(limit - allDocs.length, 100),
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: "allDrives",
      pageToken,
    });

    const files = response.data.files ?? [];

    for (const file of files) {
      allDocs.push({
        id: file.id ?? "",
        name: file.name ?? "Untitled",
        modifiedTime: file.modifiedTime ?? "",
        modifiedTimeRelative: relativeTime(file.modifiedTime),
        owner: file.owners?.[0]?.displayName ?? "Unknown",
        shared: file.shared ?? false,
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken && allDocs.length < limit);

  return allDocs.slice(0, limit);
}

function relativeTime(isoString: string | null | undefined): string {
  if (!isoString) return "unknown";

  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;

  return new Date(isoString).toISOString().slice(0, 10);
}
