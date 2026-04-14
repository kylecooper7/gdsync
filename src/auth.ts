import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as url from "url";
import * as os from "os";
import * as crypto from "crypto";

const CREDENTIALS_DIR = path.join(os.homedir(), ".gdsync");
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, "credentials.json");
const PENDING_SESSION_PATH = path.join(CREDENTIALS_DIR, "pending-session.json");

// OAuth scopes required
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

// Auth proxy URL — the default path for non-technical users.
// The proxy holds the OAuth client secret server-side.
const GDSYNC_AUTH_URL = "https://gdsync-auth.gdsync-dev.workers.dev";

// Users can override with their own credentials via file or env vars.
const CLIENT_SECRET_PATH = path.join(CREDENTIALS_DIR, "client_secret.json");

type StoredCredentials = {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  client_id?: string;
  client_secret?: string;
  auth_method?: "proxy" | "local";
  user_email?: string;
  user_name?: string;
};

// ---------------------------------------------------------------------------
// Credential loading (Tier 1 and 2 only — Tier 3 is now the auth proxy)
// ---------------------------------------------------------------------------

/**
 * Load user-provided OAuth client credentials.
 * Returns null if no local credentials are configured.
 */
function loadLocalClientSecret(): { client_id: string; client_secret: string } | null {
  // Tier 1: User-provided client_secret.json (power users / custom GCP projects)
  if (fs.existsSync(CLIENT_SECRET_PATH)) {
    const raw = fs.readFileSync(CLIENT_SECRET_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const creds = parsed.installed || parsed.web;
    if (!creds) {
      throw new Error(`Invalid client_secret.json format in ${CLIENT_SECRET_PATH}`);
    }
    return { client_id: creds.client_id, client_secret: creds.client_secret };
  }

  // Tier 2: Environment variables
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { client_id: envId, client_secret: envSecret };
  }

  return null;
}

function loadStoredCredentials(): StoredCredentials | null {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveCredentials(creds: StoredCredentials): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Pending session persistence (for two-step proxy auth)
// ---------------------------------------------------------------------------

type PendingSession = {
  sessionId: string;
  authUrl: string;
  createdAt: string; // ISO timestamp
};

const MAX_SESSION_AGE_MS = 5 * 60 * 1000; // 5 minutes

function savePendingSession(session: PendingSession): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PENDING_SESSION_PATH, JSON.stringify(session, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function loadPendingSession(): PendingSession | null {
  if (!fs.existsSync(PENDING_SESSION_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(PENDING_SESSION_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function clearPendingSession(): void {
  try {
    if (fs.existsSync(PENDING_SESSION_PATH)) fs.unlinkSync(PENDING_SESSION_PATH);
  } catch {}
}

function getAuthProxyUrl(): string {
  return process.env.GDSYNC_AUTH_URL ?? GDSYNC_AUTH_URL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryOpenBrowser(authUrl: string): void {
  try {
    const { exec } = require("child_process");
    const platform = process.platform;
    const cmd =
      platform === "darwin"
        ? `open "${authUrl}"`
        : platform === "win32"
          ? `start "" "${authUrl}"`
          : `xdg-open "${authUrl}"`;
    exec(cmd);
  } catch {
    // Browser open failed — user will use the printed URL
  }
}

// ---------------------------------------------------------------------------
// Auth flows
// ---------------------------------------------------------------------------

/**
 * Start proxy auth: generate session, print URL, persist session ID, return immediately.
 * This is step 1 of the two-step auth flow for agents.
 */
export async function startProxyAuth(): Promise<{ sessionId: string; authUrl: string }> {
  const sessionId = crypto.randomUUID();
  const proxyUrl = getAuthProxyUrl();
  const authUrl = `${proxyUrl}/login?session=${sessionId}`;

  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }

  // If local credentials exist, send them to the proxy so it uses them
  const localCreds = loadLocalClientSecret();
  if (localCreds) {
    await fetch(`${proxyUrl}/api/auth/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session: sessionId,
        clientId: localCreds.client_id,
        clientSecret: localCreds.client_secret,
      }),
    });
  }

  // Persist session so `auth check` can pick it up
  savePendingSession({ sessionId, authUrl, createdAt: new Date().toISOString() });

  console.log(`\nSign in at:\n  ${authUrl}\n`);
  tryOpenBrowser(authUrl);

  return { sessionId, authUrl };
}

/**
 * Check if the pending proxy auth session is complete.
 * Makes up to 3 quick attempts (1s apart) to handle KV propagation delay.
 *
 * @param sessionId — if provided, uses this session ID. Otherwise loads from pending-session.json.
 */
export async function checkProxyAuth(sessionId?: string): Promise<
  | { status: "complete"; userEmail?: string; userName?: string }
  | { status: "pending" }
  | { status: "error"; message: string }
> {
  let resolvedSessionId = sessionId;

  let sessionAge = 0;
  if (!resolvedSessionId) {
    const pending = loadPendingSession();
    if (!pending) {
      return { status: "error", message: "No pending auth session. Run `gdsync auth` first." };
    }

    resolvedSessionId = pending.sessionId;
    sessionAge = Date.now() - new Date(pending.createdAt).getTime();
  }

  const proxyUrl = getAuthProxyUrl();
  const statusUrl = `${proxyUrl}/api/status?session=${resolvedSessionId}`;

  // Retry up to 3 times with 1s delay to handle KV propagation
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(statusUrl);

      if (response.status === 404) {
        // 404 = session not in KV. If recent, it's KV propagation delay.
        // If old (>5 min), the KV TTL expired — session is dead.
        if (sessionAge > MAX_SESSION_AGE_MS) {
          clearPendingSession();
          return { status: "error", message: "Auth session expired. Run `gdsync auth` to start a new one." };
        }
        // Recent session — KV hasn't propagated yet, treat as pending
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(1000);
          continue;
        }
        return { status: "pending" };
      }

      if (response.ok) {
        const data = await response.json() as {
          status: string;
          tokens?: {
            access_token: string;
            refresh_token: string;
            expiry_date: number;
            client_id: string;
            user_email: string;
            user_name: string;
          };
          error?: string;
        };

        if (data.status === "complete" && data.tokens) {
          // Determine auth method based on whether local creds exist
          const localCreds = loadLocalClientSecret();
          saveCredentials({
            access_token: data.tokens.access_token,
            refresh_token: data.tokens.refresh_token,
            expiry_date: data.tokens.expiry_date,
            client_id: data.tokens.client_id,
            client_secret: localCreds?.client_secret,
            auth_method: localCreds ? "local" : "proxy",
            user_email: data.tokens.user_email,
            user_name: data.tokens.user_name,
          });

          // Clean up
          clearPendingSession();

          return {
            status: "complete",
            userEmail: data.tokens.user_email,
            userName: data.tokens.user_name,
          };
        }

        if (data.status === "error") {
          clearPendingSession();
          return { status: "error", message: `Authentication failed: ${data.error ?? "Unknown error"}` };
        }

        // Status is "pending" — if we have retries left, wait and try again
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(1000);
          continue;
        }
        return { status: "pending" };
      }

      return { status: "error", message: `Auth server returned HTTP ${response.status}` };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(1000);
        continue;
      }
      return { status: "error", message: "Could not reach auth server. Check your internet connection." };
    }
  }

  return { status: "pending" };
}


// ---------------------------------------------------------------------------
// Setup flow (GCP project creation + auth in one flow)
// ---------------------------------------------------------------------------

/**
 * Start the setup flow: generate session, print URL, persist session, return immediately.
 * The URL points to the setup wizard on the auth proxy.
 */
export async function startSetup(): Promise<{ sessionId: string; setupUrl: string }> {
  const sessionId = crypto.randomUUID();
  const proxyUrl = getAuthProxyUrl();
  const setupUrl = `${proxyUrl}/setup?session=${sessionId}`;

  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }

  // Persist session so `setup check` can pick it up
  savePendingSession({ sessionId, authUrl: setupUrl, createdAt: new Date().toISOString() });

  console.log(`\nOpen this URL to set up gdsync:\n  ${setupUrl}\n`);
  tryOpenBrowser(setupUrl);

  return { sessionId, setupUrl };
}

/**
 * Start manual setup: generate session, persist it, return the manual guide URL.
 * Does not print anything — the caller handles output.
 */
export async function startManualSetup(): Promise<{ sessionId: string; manualUrl: string }> {
  const sessionId = crypto.randomUUID();
  const proxyUrl = getAuthProxyUrl();
  const manualUrl = `${proxyUrl}/setup/manual?session=${sessionId}`;

  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }

  savePendingSession({ sessionId, authUrl: manualUrl, createdAt: new Date().toISOString() });

  return { sessionId, manualUrl };
}

/**
 * Check if the setup flow is complete. Makes a single API call to the setup status endpoint.
 * If complete, saves client credentials to ~/.gdsync/client_secret.json.
 */
export async function checkSetup(sessionId?: string): Promise<
  | { status: "complete" }
  | { status: "pending" }
  | { status: "error"; message: string }
> {
  let resolvedSessionId = sessionId;

  if (!resolvedSessionId) {
    const pending = loadPendingSession();
    if (!pending) {
      return { status: "error", message: "No pending setup session. Run `gdsync setup` first." };
    }

    // Setup sessions get 30 min (more than auth)
    const age = Date.now() - new Date(pending.createdAt).getTime();
    if (age > 30 * 60 * 1000) {
      clearPendingSession();
      return { status: "error", message: "Setup session expired. Run `gdsync setup` to start over." };
    }

    resolvedSessionId = pending.sessionId;
  }

  const proxyUrl = getAuthProxyUrl();
  const statusUrl = `${proxyUrl}/api/setup/status?session=${resolvedSessionId}`;

  try {
    const response = await fetch(statusUrl);

    if (response.status === 404) {
      return { status: "pending" };
    }

    if (response.ok) {
      const data = await response.json() as {
        status: string;
        clientId?: string;
        clientSecret?: string;
        docsTokens?: {
          access_token: string;
          refresh_token: string;
          expiry_date: number;
          client_id: string;
          user_email: string;
          user_name: string;
        };
        error?: string;
      };

      if (data.status === "complete" && data.clientId && data.clientSecret) {
        // Save client credentials
        saveClientSecret(data.clientId, data.clientSecret);

        // Save auth tokens if present
        if (data.docsTokens && data.docsTokens.access_token) {
          saveCredentials({
            access_token: data.docsTokens.access_token,
            refresh_token: data.docsTokens.refresh_token,
            expiry_date: data.docsTokens.expiry_date,
            client_id: data.docsTokens.client_id,
            client_secret: data.clientSecret,
            auth_method: "local",
            user_email: data.docsTokens.user_email,
            user_name: data.docsTokens.user_name,
          });
        }

        // Clean up pending session
        clearPendingSession();

        return { status: "complete" };
      }

      if (data.status === "error") {
        clearPendingSession();
        return { status: "error", message: data.error ?? "Setup failed." };
      }

      return { status: "pending" };
    }

    return { status: "error", message: `Setup server returned HTTP ${response.status}` };
  } catch (err) {
    return { status: "error", message: "Could not reach setup server. Check your internet connection." };
  }
}

/**
 * Save client credentials to ~/.gdsync/client_secret.json.
 */
function saveClientSecret(clientId: string, clientSecret: string): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  const data = {
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: ["http://localhost:3000/oauth2callback"],
    },
  };
  fs.writeFileSync(CLIENT_SECRET_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Check if local client credentials exist (client_secret.json or env vars).
 */
export function hasLocalCredentials(): boolean {
  return loadLocalClientSecret() !== null;
}

/**
 * Blocking proxy auth flow — composes startProxyAuth + repeated checkProxyAuth.
 * Used by `gdsync init` for the interactive human UX.
 */
async function runProxyAuthFlow(): Promise<void> {
  const { sessionId } = await startProxyAuth();
  console.log("Waiting for authentication...");

  const POLL_INTERVAL_MS = 2500;
  const MAX_POLL_TIME_MS = 5 * 60 * 1000;
  const startTime = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - startTime < MAX_POLL_TIME_MS) {
    await sleep(POLL_INTERVAL_MS);
    const result = await checkProxyAuth(sessionId);

    if (result.status === "complete") {
      console.log(`Credentials saved to ${CREDENTIALS_PATH}`);
      if (result.userName || result.userEmail) {
        console.log(`Signed in as: ${result.userName || result.userEmail}`);
      }
      console.log("Authentication successful.");
      return;
    }

    if (result.status === "error") {
      consecutiveErrors++;
      if (consecutiveErrors >= 10) {
        throw Object.assign(new Error(result.message), { exitCode: 2 });
      }
      // Transient errors — keep polling
      continue;
    }

    // status === "pending" — reset error counter, keep polling
    consecutiveErrors = 0;
  }

  throw Object.assign(
    new Error("Authentication timed out (5 minutes). Run `gdsync auth` to try again."),
    { exitCode: 2 }
  );
}

/**
 * Refresh tokens via the auth proxy (used when auth_method is "proxy").
 */
async function refreshViaProxy(refreshToken: string): Promise<{
  access_token: string;
  expiry_date: number;
}> {
  const proxyUrl = getAuthProxyUrl();
  const response = await fetch(`${proxyUrl}/api/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<{ access_token: string; expiry_date: number }>;
}

/**
 * Legacy localhost OAuth flow — used when user has their own client_secret.json or env vars.
 */
async function runLocalAuthFlow(
  creds: { client_id: string; client_secret: string }
): Promise<void> {
  const redirectUri = "http://localhost:3000/oauth2callback";
  const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("Opening browser for Google authorization...");
  console.log(
    `\nNote: You may see a "Google hasn't verified this app" warning.\n` +
      `This is normal for developer tools. Click "Advanced" then "Go to gdsync (unsafe)"\n` +
      `to proceed. gdsync only accesses documents you explicitly open.\n`
  );
  console.log(`If the browser does not open, visit:\n${authUrl}\n`);

  tryOpenBrowser(authUrl);

  // Start local server to catch the OAuth callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== "/oauth2callback") return;

      const code = parsed.query.code as string;
      const error = parsed.query.error as string;

      res.writeHead(200, { "Content-Type": "text/html" });
      if (error) {
        res.end("<h1>Authorization failed.</h1><p>You can close this window.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
      } else {
        res.end("<h1>Authorization successful!</h1><p>You can close this window.</p>");
        server.close();
        resolve(code);
      }
    });

    server.listen(3000, "localhost", () => {
      console.log("Waiting for authorization...");
    });

    server.on("error", reject);
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  saveCredentials({
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token!,
    expiry_date: tokens.expiry_date!,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    auth_method: "local",
  });

  console.log(`Credentials saved to ${CREDENTIALS_PATH}`);
  console.log("Authentication successful.");
}

// ---------------------------------------------------------------------------
// Auth client creation
// ---------------------------------------------------------------------------

/**
 * Returns an authenticated OAuth2 client, loading stored credentials.
 * Dispatches to proxy-backed or local client depending on auth_method.
 * Throws with exit code 2 if not authenticated.
 */
export async function getAuthClient(): Promise<OAuth2Client> {
  const stored = loadStoredCredentials();
  if (!stored) {
    const err = new Error(
      "Not authenticated. Run `gdsync auth` first."
    ) as Error & { exitCode: number };
    err.exitCode = 2;
    throw err;
  }

  if (stored.auth_method === "proxy" || !stored.client_secret) {
    // Proactively refresh if token is expired before returning client
    if (stored.expiry_date && Date.now() > stored.expiry_date - 60000) {
      const newTokens = await refreshViaProxy(stored.refresh_token);
      stored.access_token = newTokens.access_token;
      stored.expiry_date = newTokens.expiry_date;
      saveCredentials(stored);
    }
    return createProxyBackedAuthClient(stored);
  }

  return createLocalAuthClient(stored);
}

/**
 * Create an OAuth2Client that refreshes tokens via the auth proxy.
 */
function createProxyBackedAuthClient(stored: StoredCredentials): OAuth2Client {
  // Check if token is expired and refresh proactively before creating the client.
  // This avoids relying on the googleapis library's internal refresh, which
  // needs a client_secret we don't have.
  if (stored.expiry_date && Date.now() > stored.expiry_date - 60000) {
    // Token expired or expiring within 60s — refresh synchronously isn't possible,
    // so we'll set up the client to refresh on first use via getAccessToken override.
  }

  const oauth2Client = new google.auth.OAuth2(
    stored.client_id ?? "proxy-managed"
  );

  oauth2Client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date,
  });

  // Override getAccessToken — this is what the googleapis library calls
  // internally before each API request when the token is expired.
  const originalGetAccessToken = oauth2Client.getAccessToken.bind(oauth2Client);
  oauth2Client.getAccessToken = async function (callback?: any) {
    // If token is still valid, return it
    if (this.credentials.expiry_date && Date.now() < this.credentials.expiry_date - 60000) {
      const token = this.credentials.access_token ?? null;
      if (callback) callback(null, token);
      return { token, res: null as any };
    }

    // Token expired — refresh via proxy
    try {
      const newTokens = await refreshViaProxy(stored.refresh_token);
      const updated: StoredCredentials = {
        ...stored,
        access_token: newTokens.access_token,
        expiry_date: newTokens.expiry_date,
      };
      saveCredentials(updated);
      stored.access_token = newTokens.access_token;
      stored.expiry_date = newTokens.expiry_date;

      this.setCredentials({
        access_token: newTokens.access_token,
        refresh_token: stored.refresh_token,
        expiry_date: newTokens.expiry_date,
      });

      const token = newTokens.access_token;
      if (callback) callback(null, token);
      return { token, res: null as any };
    } catch (err) {
      if (callback) callback(err);
      throw err;
    }
  };

  // Also override refreshAccessToken for direct calls
  oauth2Client.refreshAccessToken = async function (callback?: any) {
    try {
      const newTokens = await refreshViaProxy(stored.refresh_token);
      const updated: StoredCredentials = {
        ...stored,
        access_token: newTokens.access_token,
        expiry_date: newTokens.expiry_date,
      };
      saveCredentials(updated);
      stored.access_token = newTokens.access_token;
      stored.expiry_date = newTokens.expiry_date;

      this.setCredentials({
        access_token: newTokens.access_token,
        refresh_token: stored.refresh_token,
        expiry_date: newTokens.expiry_date,
      });

      const credentials = this.credentials;
      if (callback) callback(null, { credentials, res: null });
      return { credentials, res: null as any };
    } catch (err) {
      if (callback) callback(err);
      throw err;
    }
  };

  return oauth2Client;
}

/**
 * Create an OAuth2Client that refreshes tokens locally (has client_secret).
 * This is the legacy flow for users with their own GCP credentials.
 */
function createLocalAuthClient(stored: StoredCredentials): OAuth2Client {
  const oauth2Client = new google.auth.OAuth2(
    stored.client_id,
    stored.client_secret,
    "http://localhost:3000/oauth2callback"
  );

  oauth2Client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date,
  });

  // Refresh tokens automatically via the googleapis library
  oauth2Client.on("tokens", (tokens) => {
    const updated: StoredCredentials = {
      ...stored,
      access_token: tokens.access_token ?? stored.access_token,
      expiry_date: tokens.expiry_date ?? stored.expiry_date,
    };
    if (tokens.refresh_token) {
      updated.refresh_token = tokens.refresh_token;
    }
    saveCredentials(updated);
  });

  return oauth2Client;
}

// ---------------------------------------------------------------------------
// Auth status checks
// ---------------------------------------------------------------------------

/**
 * Non-throwing check: are we authenticated?
 */
export function isAuthenticated(): boolean {
  const stored = loadStoredCredentials();
  if (!stored) return false;

  // Proxy auth: valid if we have a refresh token
  if (stored.auth_method === "proxy" || !stored.client_secret) {
    return !!stored.refresh_token;
  }

  // Local auth: check that stored credentials match current client config
  const localCreds = loadLocalClientSecret();
  if (!localCreds) return false;
  return stored.client_id === localCreds.client_id;
}

/**
 * Get the authenticated user's identity (name and email).
 * Returns null if not available.
 */
export function getAuthUserInfo(): { email: string; name: string } | null {
  const stored = loadStoredCredentials();
  if (!stored?.user_email && !stored?.user_name) return null;
  return { email: stored.user_email ?? "", name: stored.user_name ?? "" };
}
