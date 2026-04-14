/**
 * session.ts — In-memory session state management.
 *
 * The session is held in-process for the duration of a fetch→commit cycle.
 * Since the CLI is a stateless process-per-invocation tool, we persist minimal
 * state to .gdsync-session (a temp JSON file) so fetch + commit can share the
 * block map across process boundaries.
 */

import * as fs from "fs";
import * as path from "path";
import { SessionState, BlockMap, BlockMapEntry, Config, Block } from "./types.js";

const SESSION_FILE = ".gdsync-session";

type SerializedSession = {
  config: Config;
  blockMap: Array<[string, BlockMapEntry]>;
  fetchedBlocks: Block[];
  fetchedAt: string;
};

/**
 * Save session state to .gdsync-session in the working directory.
 */
export function saveSession(workDir: string, session: SessionState): void {
  const filePath = path.join(workDir, SESSION_FILE);
  const serialized: SerializedSession = {
    config: session.config,
    blockMap: Array.from(session.blockMap.entries()),
    fetchedBlocks: session.fetchedBlocks,
    fetchedAt: session.fetchedAt.toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2), "utf-8");
}

/**
 * Load session state from .gdsync-session.
 * Returns null if not found.
 */
export function loadSession(workDir: string): SessionState | null {
  const filePath = path.join(workDir, SESSION_FILE);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as SerializedSession;

    const blockMap: BlockMap = new Map(data.blockMap);

    return {
      config: data.config,
      blockMap,
      fetchedBlocks: data.fetchedBlocks,
      fetchedAt: new Date(data.fetchedAt),
    };
  } catch (err) {
    console.error("Warning: failed to load session state:", err);
    return null;
  }
}

/**
 * Clear the session file.
 */
export function clearSession(workDir: string): void {
  const filePath = path.join(workDir, SESSION_FILE);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Load the .gdsync config file from the working directory.
 */
export function loadConfig(workDir: string): Config {
  const configPath = path.join(workDir, ".gdsync");
  if (!fs.existsSync(configPath)) {
    const err = new Error(
      "No .gdsync config found. Run `gdsync start --doc <documentId>` first."
    ) as Error & { exitCode: number };
    err.exitCode = 1;
    throw err;
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Config;
}

/**
 * Save the .gdsync config file.
 */
export function saveConfig(workDir: string, config: Config): void {
  const configPath = path.join(workDir, ".gdsync");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
