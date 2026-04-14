#!/usr/bin/env node
/**
 * cli.ts — Commander CLI entry point for gdsync.
 */

import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import {
  getAuthClient,
  isAuthenticated,
  getAuthUserInfo,
  startProxyAuth,
  checkProxyAuth,
  startSetup,
  checkSetup,
  hasLocalCredentials,
} from "./auth.js";
import { fetchDocument } from "./fetch.js";
import { commitDocument } from "./commit.js";
import { verifyDocument } from "./verify.js";
import { loadConfig, saveConfig, loadSession, saveSession, clearSession } from "./session.js";
import { parseContentFile } from "./contentFile.js";
import { diffBlocks } from "./contentFile.js";
import { SessionState, Config } from "./types.js";
import {
  replyToComment,
  resolveComment,
  createComment,
  refreshCommentsFile,
} from "./comments.js";

/**
 * Get the mention filter if comment_filter is enabled in config.
 */
function getMentionFilter(config: Config): { email: string; name: string } | undefined {
  if (!config.commentFilter) return undefined;
  const userInfo = getAuthUserInfo();
  if (!userInfo) return undefined;
  return userInfo;
}

const program = new Command();

program
  .name("gdsync")
  .description("Sync a Google Doc to a local content file for AI agent editing")
  .version("1.0.0");

// ---------------------------------------------------------------------------
// gdsync init
// ---------------------------------------------------------------------------
program
  .command("init")
  .description("Set up gdsync for a Google Doc (handles auth automatically)")
  .requiredOption("--doc <documentId>", "Google Doc document ID (from the URL)")
  .option("--mode <mode>", "Sync mode: auto or suggestions", "auto")
  .action(async (options) => {
    const workDir = process.cwd();
    const mode = options.mode as "auto" | "suggestions";

    if (mode !== "auto" && mode !== "suggestions") {
      console.error("Error: --mode must be 'auto' or 'suggestions'");
      process.exit(1);
    }

    try {
      // Step 1: Check auth
      if (!isAuthenticated()) {
        console.error("Not authenticated. Run `gdsync auth` first.");
        process.exit(2);
      } else {
        console.log("Already authenticated.");
      }

      // Step 2: Fetch document
      const auth = await getAuthClient();
      console.log("Fetching document...");

      const result = await fetchDocument(auth, options.doc, workDir);

      const config: Config = {
        documentId: options.doc,
        documentTitle: result.title,
        mode,
      };

      saveConfig(workDir, config);

      const session: SessionState = {
        config,
        blockMap: result.blockMap,
        fetchedBlocks: result.blocks,
        fetchedAt: new Date(),
      };
      saveSession(workDir, session);

      // Generate .gitignore if it doesn't exist
      const gitignorePath = path.join(workDir, ".gitignore");
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, [
          ".gdsync-session",
          "assets/",
          "comments.txt",
          "",
        ].join("\n"), "utf-8");
      }

      console.log(
        `\nReady! "${result.title}" — ${result.blockCount} blocks loaded into content.txt`
      );
      console.log("\nNext steps:");
      console.log("  - Edit content.txt (or let an AI agent edit it)");
      console.log("  - Run `gdsync commit` to push changes to the doc");
      console.log("  - Run `gdsync fetch` to pull latest changes from the doc");
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Init failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync auth (subcommand group)
// ---------------------------------------------------------------------------
const authCmd = program
  .command("auth")
  .description("Authenticate with Google for document access");

// Default: "gdsync auth" — requires local credentials from setup
authCmd
  .action(async () => {
    try {
      if (isAuthenticated()) {
        console.log("Already authenticated.");
        process.exit(0);
      }

      if (!hasLocalCredentials()) {
        console.error("No credentials configured. Run `gdsync setup` first to create your GCP project.");
        process.exit(2);
      }

      await startProxyAuth();
      console.log("Run `gdsync auth check` after signing in.");
      process.exit(0);
    } catch (err) {
      console.error("Auth failed:", (err as Error).message);
      process.exit(2);
    }
  });

// gdsync auth check
authCmd
  .command("check")
  .description("Check if authentication is complete")
  .action(async () => {
    try {
      if (isAuthenticated()) {
        console.log("Already authenticated.");
        process.exit(0);
      }

      if (!hasLocalCredentials()) {
        console.error("No credentials configured. Run `gdsync setup` first.");
        process.exit(2);
      }

      const result = await checkProxyAuth();

      if (result.status === "complete") {
        if (result.userName || result.userEmail) {
          console.log(`Signed in as: ${result.userName || result.userEmail}`);
        }
        console.log("Authentication successful.");
        process.exit(0);
      }

      if (result.status === "pending") {
        console.log("Waiting for sign-in... Run `gdsync auth check` again after the user signs in.");
        process.exit(1);
      }

      if (result.status === "error") {
        console.error(result.message);
        process.exit(2);
      }
    } catch (err) {
      console.error("Auth check failed:", (err as Error).message);
      process.exit(2);
    }
  });

// ---------------------------------------------------------------------------
// gdsync setup (subcommand group) — required first step
// ---------------------------------------------------------------------------
const setupCmd = program
  .command("setup")
  .description("Set up your GCP project for Google Docs access");

// Default: "gdsync setup" runs the guided wizard
setupCmd
  .action(async () => {
    try {
      if (hasLocalCredentials()) {
        if (isAuthenticated()) {
          console.log("Already set up and authenticated. Ready to go.");
          process.exit(0);
        }
        console.log("Credentials configured. Run `gdsync auth` to authenticate.");
        process.exit(0);
      }

      const { setupUrl } = await startSetup();
      console.log("Complete the setup in your browser, then run `gdsync setup check`.");
      console.log("\nAlready have a GCP project? Run `gdsync setup manual` instead.");
      process.exit(0);
    } catch (err) {
      console.error("Setup failed:", (err as Error).message);
      process.exit(2);
    }
  });

// gdsync setup check
setupCmd
  .command("check")
  .description("Check if the setup wizard is complete")
  .action(async () => {
    try {
      if (hasLocalCredentials()) {
        console.log("Setup complete. Client credentials configured.");
        console.log("Run `gdsync auth` to authenticate for document access.");
        process.exit(0);
      }

      const result = await checkSetup();

      if (result.status === "complete") {
        console.log("Setup complete. Client credentials saved.");
        console.log("Run `gdsync auth` to authenticate for document access.");
        process.exit(0);
      }

      if (result.status === "pending") {
        console.log("Setup not complete yet. Finish the steps in your browser,");
        console.log("then run `gdsync setup check` again.");
        process.exit(1);
      }

      if (result.status === "error") {
        console.error(result.message);
        process.exit(2);
      }
    } catch (err) {
      console.error("Setup check failed:", (err as Error).message);
      process.exit(2);
    }
  });

// gdsync setup manual
setupCmd
  .command("manual")
  .description("Manual GCP project setup with a step-by-step guide (no automated GCP access)")
  .action(async () => {
    try {
      if (hasLocalCredentials()) {
        console.log("Credentials already configured. Run `gdsync auth` to authenticate.");
        process.exit(0);
      }

      const { startManualSetup } = await import("./auth.js");
      const { manualUrl } = await startManualSetup();
      console.log(`\nFollow the setup guide at:\n  ${manualUrl}\n`);
      console.log("This guide walks you through creating a GCP project yourself.");
      console.log("No automated access to your Google Cloud account is needed.\n");
      console.log("After completing the guide, run `gdsync setup check`.");

      // Open the manual guide URL instead of the auto flow
      try {
        const { exec } = require("child_process");
        const cmd = process.platform === "darwin" ? `open "${manualUrl}"` :
          process.platform === "win32" ? `start "" "${manualUrl}"` : `xdg-open "${manualUrl}"`;
        exec(cmd);
      } catch {}

      process.exit(0);
    } catch (err) {
      console.error("Setup manual failed:", (err as Error).message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync start
// ---------------------------------------------------------------------------
program
  .command("start")
  .description("Initialize a sync session for a Google Doc in the current directory")
  .requiredOption("--doc <documentId>", "Google Doc document ID (from the URL)")
  .option("--mode <mode>", "Sync mode: auto or suggestions", "auto")
  .action(async (options) => {
    const workDir = process.cwd();
    const mode = options.mode as "auto" | "suggestions";

    if (mode !== "auto" && mode !== "suggestions") {
      console.error("Error: --mode must be 'auto' or 'suggestions'");
      process.exit(1);
    }

    try {
      let auth;
      try {
        auth = await getAuthClient();
      } catch (authErr) {
        const ae = authErr as Error & { exitCode?: number };
        if (ae.exitCode === 2) {
          console.error("Not authenticated. Run `gdsync auth` first.");
          process.exit(2);
        }
        throw authErr;
      }
      console.log("Authenticated. Fetching document...");

      const result = await fetchDocument(auth, options.doc, workDir);

      const config: Config = {
        documentId: options.doc,
        documentTitle: result.title,
        mode,
      };

      saveConfig(workDir, config);

      const session: SessionState = {
        config,
        blockMap: result.blockMap,
        fetchedBlocks: result.blocks,
        fetchedAt: new Date(),
      };
      saveSession(workDir, session);

      console.log(
        `Fetched "${result.title}" — ${result.blockCount} blocks loaded into content.txt`
      );
      console.log("Ready. Run gdsync fetch to refresh, gdsync commit to push changes.");
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Start failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync fetch
// ---------------------------------------------------------------------------
program
  .command("fetch")
  .description("Pull latest document state from Google into content.txt")
  .action(async () => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const auth = await getAuthClient();

      const result = await fetchDocument(auth, config.documentId, workDir, getMentionFilter(config));

      const session: SessionState = {
        config,
        blockMap: result.blockMap,
        fetchedBlocks: result.blocks,
        fetchedAt: new Date(),
      };
      saveSession(workDir, session);

      console.log(
        `Fetched "${result.title}" — ${result.blockCount} blocks loaded into content.txt`
      );
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Fetch failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync commit
// ---------------------------------------------------------------------------
program
  .command("commit")
  .description("Push changes from content.txt to the Google Doc and verify")
  .action(async () => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const session = loadSession(workDir);

      if (!session) {
        console.error(
          "No session state found. Run `gdsync fetch` first."
        );
        process.exit(1);
      }

      const auth = await getAuthClient();

      // Commit phase — use config.mode (live from .gdsync), not session.config.mode (stale)
      const result = await commitDocument(auth, config.documentId, workDir, session, config.mode);

      const parts: string[] = [];
      if (result.modified > 0) parts.push(`${result.modified} block${result.modified === 1 ? "" : "s"} modified`);
      if (result.added > 0) parts.push(`${result.added} block${result.added === 1 ? "" : "s"} added`);
      if (result.deleted > 0) parts.push(`${result.deleted} block${result.deleted === 1 ? "" : "s"} deleted`);

      if (parts.length === 0) {
        console.log("No changes detected.");
      } else {
        console.log(`Committed. ${parts.join(", ")}.`);
      }

      // Verify phase — re-fetch and validate
      const contentPath = path.join(workDir, "content.txt");
      const committedBlocks = parseContentFile(contentPath);

      const verifyResult = await verifyDocument(
        auth,
        config.documentId,
        workDir,
        committedBlocks,
        session,
        getMentionFilter(config)
      );

      // Save new session state
      saveSession(workDir, verifyResult.newSession);

      if (verifyResult.success) {
        console.log("Verified — document matches.");
        process.exit(0);
      } else {
        console.error("Committed but verify failed. Diff:");
        for (const d of verifyResult.diff) {
          console.error(`  ${d.blockId}: expected "${d.expected}" got "${d.got}"`);
        }
        console.error("Run gdsync fetch to pull the current state.");
        process.exit(5);
      }
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Commit failed:", e.message);
      if (e.message.includes("Image not found")) {
        const match = e.message.match(/block (blk_\d+)/);
        if (match) {
          console.error(`Block ${match[1]} not synced. Fix the path and retry.`);
        }
      }
      process.exit(e.exitCode ?? 4);
    }
  });

// ---------------------------------------------------------------------------
// gdsync status
// ---------------------------------------------------------------------------
program
  .command("status")
  .description("Show current sync session state")
  .action(() => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const session = loadSession(workDir);

      console.log(`Document: "${config.documentTitle}" (${config.documentId})`);
      console.log(`Mode: ${config.mode}`);

      if (!session) {
        console.log("No active session. Run gdsync fetch.");
        process.exit(0);
      }

      const elapsed = Math.round((Date.now() - session.fetchedAt.getTime()) / 1000);
      const timeStr =
        elapsed < 60
          ? `${elapsed} seconds ago`
          : `${Math.round(elapsed / 60)} minutes ago`;
      console.log(`Last fetch: ${timeStr}`);
      console.log(`Blocks: ${session.fetchedBlocks.length}`);

      // Check for pending changes
      const contentPath = path.join(workDir, "content.txt");
      if (fs.existsSync(contentPath)) {
        const currentBlocks = parseContentFile(contentPath);
        const { modified, added, deleted } = diffBlocks(session.fetchedBlocks, currentBlocks);
        const changeParts: string[] = [];
        if (modified.length > 0) changeParts.push(`${modified.length} modified`);
        if (added.length > 0) changeParts.push(`${added.length} new`);
        if (deleted.length > 0) changeParts.push(`${deleted.length} deleted`);
        console.log(`Pending changes: ${changeParts.length > 0 ? changeParts.join(", ") : "none"}`);
      }

      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Status failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync reset
// ---------------------------------------------------------------------------
program
  .command("reset")
  .description("Clear in-memory state and re-fetch from scratch")
  .action(async () => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      clearSession(workDir);

      const auth = await getAuthClient();
      console.log("Resetting... fetching fresh state.");

      const result = await fetchDocument(auth, config.documentId, workDir, getMentionFilter(config));

      const session: SessionState = {
        config,
        blockMap: result.blockMap,
        fetchedBlocks: result.blocks,
        fetchedAt: new Date(),
      };
      saveSession(workDir, session);

      console.log(
        `Reset complete. "${result.title}" — ${result.blockCount} blocks loaded.`
      );
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Reset failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync config
// ---------------------------------------------------------------------------
program
  .command("config")
  .description("View or update gdsync settings")
  .argument("[key]", "Setting to view or change (e.g. mode)")
  .argument("[value]", "New value to set")
  .action((key?: string, value?: string) => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);

      // No arguments: show all settings
      if (!key) {
        console.log(`document: ${config.documentId}`);
        console.log(`title: ${config.documentTitle}`);
        console.log(`comment_filter: ${config.commentFilter ? "on" : "off"}`);
        console.log(`mode: ${config.mode}`);
        process.exit(0);
      }

      // Key only: show that setting
      if (!value) {
        switch (key) {
          case "mode":
            console.log(config.mode);
            break;
          case "document":
            console.log(config.documentId);
            break;
          case "title":
            console.log(config.documentTitle);
            break;
          case "comment_filter":
            console.log(config.commentFilter ? "on" : "off");
            break;
          default:
            console.error(`Unknown setting: ${key}`);
            console.error("Available settings: mode, comment_filter, document, title");
            process.exit(1);
        }
        process.exit(0);
      }

      // Key + value: update the setting
      switch (key) {
        case "mode":
          if (value !== "auto" && value !== "suggestions") {
            console.error("Error: mode must be 'auto' or 'suggestions'");
            process.exit(1);
          }
          config.mode = value;
          saveConfig(workDir, config);
          console.log(`Mode set to: ${value}`);
          break;
        case "comment_filter":
          if (value !== "on" && value !== "off") {
            console.error("Error: comment_filter must be 'on' or 'off'");
            process.exit(1);
          }
          config.commentFilter = value === "on";
          saveConfig(workDir, config);
          console.log(`Comment filter set to: ${value}`);
          break;
        default:
          console.error(`Setting '${key}' is read-only or unknown.`);
          console.error("Changeable settings: mode, comment_filter");
          process.exit(1);
      }

      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Config failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync dev-setup
// ---------------------------------------------------------------------------
program
  .command("dev-setup")
  .description("(Optional) Set up your own GCP project for custom OAuth credentials")
  .action(async () => {
    const { execSync } = await import("child_process");

    console.log("=== gdsync Developer Setup ===\n");
    console.log("NOTE: This is optional. By default, gdsync uses a hosted auth proxy");
    console.log("so you can authenticate without any GCP setup. Just run `gdsync setup`.\n");
    console.log("This wizard is for power users who want to use their own GCP project.\n");

    let hasGcloud = false;
    try {
      execSync("gcloud --version", { stdio: "ignore" });
      hasGcloud = true;
    } catch {
      console.log("Note: gcloud CLI not found. Manual steps will be shown instead.\n");
    }

    const projectId = "gdsync-oauth";

    if (hasGcloud) {
      console.log("Step 1: Create GCP project");
      console.log(`  Run: gcloud projects create ${projectId} --name="gdsync"`);
      console.log(`  Then: gcloud config set project ${projectId}\n`);

      console.log("Step 2: Enable APIs");
      console.log("  Run: gcloud services enable docs.googleapis.com drive.googleapis.com\n");
    } else {
      console.log("Step 1: Go to https://console.cloud.google.com/projectcreate");
      console.log(`  Create a project named "gdsync" (suggested ID: ${projectId})\n`);

      console.log("Step 2: Enable APIs at:");
      console.log("  https://console.cloud.google.com/apis/library/docs.googleapis.com");
      console.log("  https://console.cloud.google.com/apis/library/drive.googleapis.com\n");
    }

    console.log("Step 3: Configure OAuth consent screen (must be done in browser)");
    console.log("  Go to: https://console.cloud.google.com/apis/credentials/consent");
    console.log("  - User type: External");
    console.log("  - App name: gdsync");
    console.log("  - Scopes: .../auth/documents, .../auth/drive");
    console.log("  - Test users: add your email\n");

    console.log("Step 4: Create OAuth client ID (must be done in browser)");
    console.log("  Go to: https://console.cloud.google.com/apis/credentials");
    console.log("  - Click 'Create Credentials' → 'OAuth client ID'");
    console.log("  - Application type: Desktop app");
    console.log("  - Name: gdsync-cli\n");

    console.log("Step 5: Download the OAuth client secret JSON from the console");
    console.log("  and save it as: ~/.gdsync/client_secret.json\n");
    console.log("  Alternatively, set environment variables:");
    console.log("    export GOOGLE_CLIENT_ID=<your client id>");
    console.log("    export GOOGLE_CLIENT_SECRET=<your client secret>\n");

    console.log("Done! Run `gdsync setup` to authenticate with your custom credentials.");
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// gdsync docs
// ---------------------------------------------------------------------------
program
  .command("docs")
  .description("List Google Docs accessible to the authenticated user")
  .option("--search <query>", "Search docs by name")
  .option("--limit <n>", "Max number of docs to show", "20")
  .action(async (options) => {
    try {
      const auth = await getAuthClient();
      const { listDocs } = await import("./docs-list.js");
      const docs = await listDocs(auth, {
        search: options.search,
        limit: parseInt(options.limit, 10),
      });

      if (docs.length === 0) {
        if (options.search) {
          console.log(`No docs found matching "${options.search}".`);
        } else {
          console.log("No Google Docs found. Make sure docs are shared with this account.");
        }
        process.exit(0);
      }

      console.log("");
      for (const doc of docs) {
        console.log(`  ${doc.name}`);
        console.log(`  ID: ${doc.id}`);
        console.log(`  Modified: ${doc.modifiedTimeRelative}  |  Owner: ${doc.owner}${doc.shared ? "  |  Shared" : ""}`);
        console.log("");
      }

      console.log(`${docs.length} doc${docs.length === 1 ? "" : "s"} found.`);
      console.log(`Run: gdsync init --doc <ID>`);
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Failed to list docs:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// ---------------------------------------------------------------------------
// gdsync comment (subcommand group)
// ---------------------------------------------------------------------------
const commentCmd = program
  .command("comment")
  .description("Manage comments on the Google Doc");

// gdsync comment list
commentCmd
  .command("list")
  .description("Show all open comment threads (reads comments.txt)")
  .option("--include-resolved", "Include resolved comment threads")
  .action(async (options) => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const session = loadSession(workDir);
      if (!session) {
        console.error("No session state found. Run `gdsync fetch` first.");
        process.exit(1);
      }

      const auth = await getAuthClient();
      const threads = await refreshCommentsFile(
        auth,
        config.documentId,
        workDir,
        session.blockMap,
        options.includeResolved,
        getMentionFilter(config)
      );

      // Print comments.txt to stdout
      const commentsPath = path.join(workDir, "comments.txt");
      if (fs.existsSync(commentsPath)) {
        console.log(fs.readFileSync(commentsPath, "utf-8"));
      }

      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Comment list failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// gdsync comment reply <threadId> <message>
commentCmd
  .command("reply")
  .description("Reply to an existing comment thread")
  .argument("<threadId>", "Comment thread ID (from comments.txt header)")
  .argument("<message>", "Reply message text")
  .action(async (threadId: string, message: string) => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const session = loadSession(workDir);
      if (!session) {
        console.error("No session state found. Run `gdsync fetch` first.");
        process.exit(1);
      }

      const auth = await getAuthClient();
      await replyToComment(auth, config.documentId, threadId, message);
      console.log(`Replied to thread ${threadId}.`);

      // Refresh comments.txt
      await refreshCommentsFile(auth, config.documentId, workDir, session.blockMap, false, getMentionFilter(config));
      console.log("comments.txt updated.");
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Comment reply failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// gdsync comment resolve <threadId>
commentCmd
  .command("resolve")
  .description("Resolve a comment thread, optionally with a final reply")
  .argument("<threadId>", "Comment thread ID (from comments.txt header)")
  .option("--reply <message>", "Post a reply before resolving")
  .action(async (threadId: string, options: { reply?: string }) => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const session = loadSession(workDir);
      if (!session) {
        console.error("No session state found. Run `gdsync fetch` first.");
        process.exit(1);
      }

      const auth = await getAuthClient();
      await resolveComment(auth, config.documentId, threadId, options.reply);
      console.log(`Resolved thread ${threadId}.`);

      // Refresh comments.txt
      await refreshCommentsFile(auth, config.documentId, workDir, session.blockMap, false, getMentionFilter(config));
      console.log("comments.txt updated.");
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Comment resolve failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

// gdsync comment create <blockId> <message>
commentCmd
  .command("create")
  .description("Create a new comment on the document")
  .argument("<blockId>", "Block ID to comment on (e.g. blk_5)")
  .argument("<message>", "Comment text")
  .option("--anchor <text>", "Exact text to highlight within the block")
  .action(async (blockId: string, message: string, options: { anchor?: string }) => {
    const workDir = process.cwd();

    try {
      const config = loadConfig(workDir);
      const session = loadSession(workDir);
      if (!session) {
        console.error("No session state found. Run `gdsync fetch` first.");
        process.exit(1);
      }

      const auth = await getAuthClient();
      await createComment(
        auth,
        config.documentId,
        blockId,
        message,
        session.blockMap,
        options.anchor
      );
      console.log(`Created comment on ${blockId}.`);

      // Refresh comments.txt
      await refreshCommentsFile(auth, config.documentId, workDir, session.blockMap, false, getMentionFilter(config));
      console.log("comments.txt updated.");
      process.exit(0);
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      console.error("Comment create failed:", e.message);
      process.exit(e.exitCode ?? 1);
    }
  });

program.parse(process.argv);
