/**
 * images.ts — Image download (during fetch) and upload (during commit).
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Download a single image from a URL and save it to `destPath`.
 * Returns true on success, false on failure.
 */
export async function downloadImage(imageUrl: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const protocol = imageUrl.startsWith("https://") ? https : http;

    const request = protocol.get(imageUrl, (response) => {
      if (response.statusCode !== 200) {
        console.warn(`Warning: failed to download image (HTTP ${response.statusCode}): ${imageUrl}`);
        resolve(false);
        return;
      }

      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const writeStream = fs.createWriteStream(destPath);
      response.pipe(writeStream);
      writeStream.on("finish", () => resolve(true));
      writeStream.on("error", (err) => {
        console.warn(`Warning: failed to save image to ${destPath}: ${err.message}`);
        resolve(false);
      });
    });

    request.on("error", (err) => {
      console.warn(`Warning: failed to download image: ${err.message}`);
      resolve(false);
    });

    request.setTimeout(30000, () => {
      request.destroy();
      console.warn(`Warning: image download timed out: ${imageUrl}`);
      resolve(false);
    });
  });
}

/**
 * Upload a local image file to Google Drive (public) and return its URL.
 * After insertion, the temp Drive file can optionally be deleted.
 */
export async function uploadImageToDrive(
  auth: OAuth2Client,
  localPath: string
): Promise<{ driveFileId: string; publicUrl: string }> {
  const drive = google.drive({ version: "v3", auth });

  const fileSize = fs.statSync(localPath).size;
  if (fileSize > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large: ${localPath} (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max 50MB.`
    );
  }

  const ext = path.extname(localPath).slice(1).toLowerCase();
  const mimeType =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "gif"
        ? "image/gif"
        : "image/png";

  const response = await drive.files.create({
    requestBody: {
      name: path.basename(localPath),
      mimeType,
    },
    media: {
      mimeType,
      body: fs.createReadStream(localPath),
    },
    fields: "id",
  });

  const fileId = response.data.id!;

  // Make publicly accessible
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  const publicUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
  return { driveFileId: fileId, publicUrl };
}

/**
 * Delete a Drive file (cleanup after image insertion).
 */
export async function deleteDriveFile(auth: OAuth2Client, fileId: string): Promise<void> {
  const drive = google.drive({ version: "v3", auth });
  try {
    await drive.files.delete({ fileId });
  } catch {
    // Non-fatal
  }
}

/**
 * Check that all images referenced in content blocks exist locally.
 * Returns list of missing paths.
 */
export function checkImageFiles(
  imageRefs: Array<{ blockId: string | null; localPath: string }>
): Array<{ blockId: string | null; localPath: string }> {
  return imageRefs.filter(({ localPath }) => !fs.existsSync(localPath));
}
