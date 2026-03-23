#!/usr/bin/env node
// =============================================================================
// Linear OAuth — Token Manager
//
// Two modes:
//   1. Setup: Run interactively to authorize via browser and store tokens
//      node linear-oauth.mjs setup
//
//   2. Library: Import getLinearToken() in the orchestrator for auto-refreshing
//      access tokens
//
// Linear OAuth flow:
//   - Authorization code grant (RFC 6749 Section 4.1)
//   - Access tokens expire (configurable, typically ~10 hours)
//   - Refresh tokens do not expire (unless revoked)
//   - Scopes: read, write (for issues + comments)
//
// Prerequisites:
//   Create an OAuth app at https://linear.app/settings/api/applications/new
//   Set redirect URI to: http://localhost:3456/callback
//   Note the client ID and client secret
// =============================================================================

import { createServer } from "http";
import https from "https";
import { execSync as execSyncFn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Auto-load .env file ───────────────────────────────────────────────────
function loadEnvFile() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env) || process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
loadEnvFile();

// ─── Configuration ──────────────────────────────────────────────────────────
const LINEAR_CLIENT_ID = process.env.LINEAR_CLIENT_ID || "";
const LINEAR_CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET || "";
const LINEAR_REDIRECT_URI = process.env.LINEAR_REDIRECT_URI || "http://localhost:3456/callback";
const LINEAR_SCOPES = process.env.LINEAR_SCOPES || "read,write";

const TOKEN_FILE = process.env.LINEAR_TOKEN_FILE || join(__dirname, ".linear-tokens.json");

const LINEAR_AUTH_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

// ─── HTTPS request helper (works on Node 14+, no fetch needed) ──────────────
function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => data,
          json: () => JSON.parse(data),
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Token storage ──────────────────────────────────────────────────────────
function loadTokens() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  const data = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || "Bearer",
    expires_at: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : tokens.expires_at || null,
    scope: tokens.scope || LINEAR_SCOPES,
    saved_at: new Date().toISOString(),
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  return data;
}

// ─── Token exchange & refresh ───────────────────────────────────────────────
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: LINEAR_CLIENT_ID,
    client_secret: LINEAR_CLIENT_SECRET,
    redirect_uri: LINEAR_REDIRECT_URI,
    code,
  }).toString();

  const res = await httpsRequest(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.text()}`);
  }

  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: LINEAR_CLIENT_ID,
    client_secret: LINEAR_CLIENT_SECRET,
    refresh_token: refreshToken,
  }).toString();

  const res = await httpsRequest(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${res.text()}`);
  }

  return res.json();
}

// ─── Public API: get a valid access token (auto-refreshes) ──────────────────
export async function getLinearToken() {
  const clientId = process.env.LINEAR_CLIENT_ID || LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET || LINEAR_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are required for OAuth. " +
      "Set them as environment variables."
    );
  }

  const tokens = loadTokens();

  if (!tokens) {
    throw new Error(
      "No Linear OAuth tokens found. Run the setup first:\n" +
      "  node linear-oauth.mjs setup\n" +
      `(looking for token file at: ${TOKEN_FILE})`
    );
  }

  // Check if token is still valid (with 5-minute buffer)
  const bufferMs = 5 * 60 * 1000;
  if (tokens.expires_at && Date.now() < tokens.expires_at - bufferMs) {
    return tokens.access_token;
  }

  // Token expired — refresh it
  if (!tokens.refresh_token) {
    throw new Error(
      "Linear access token expired and no refresh token available. " +
      "Run setup again: node linear-oauth.mjs setup"
    );
  }

  console.log("[linear-oauth] Access token expired, refreshing...");

  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const saved = saveTokens({
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  });

  console.log("[linear-oauth] Token refreshed successfully");
  return saved.access_token;
}

// ─── Setup flow (interactive) ───────────────────────────────────────────────
async function runSetup() {
  if (!LINEAR_CLIENT_ID || !LINEAR_CLIENT_SECRET) {
    console.error("Set these environment variables before running setup:");
    console.error("  LINEAR_CLIENT_ID=your-client-id");
    console.error("  LINEAR_CLIENT_SECRET=your-client-secret");
    console.error("");
    console.error("Create an OAuth app at:");
    console.error("  https://linear.app/settings/api/applications/new");
    console.error(`  Set redirect URI to: ${LINEAR_REDIRECT_URI}`);
    process.exit(1);
  }

  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(LINEAR_AUTH_URL);
  authUrl.searchParams.set("client_id", LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", LINEAR_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", LINEAR_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "consent");

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Linear OAuth Setup");
  console.log("═══════════════════════════════════════════════════════");
  console.log("");
  console.log("Open this URL in your browser to authorize:");
  console.log("");
  console.log(`  ${authUrl.toString()}`);
  console.log("");
  console.log("Waiting for callback...");

  const port = new URL(LINEAR_REDIRECT_URI).port || 3456;

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        console.error(`\nAuthorization failed: ${error}`);
        server.close();
        process.exit(1);
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch — possible CSRF</h1>");
        console.error("\nState mismatch — aborting");
        server.close();
        process.exit(1);
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>No authorization code received</h1>");
        console.error("\nNo code in callback");
        server.close();
        process.exit(1);
      }

      try {
        console.log("\nExchanging authorization code for tokens...");
        const tokens = await exchangeCode(code);
        const saved = saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authorization successful!</h1>" +
          "<p>You can close this tab and return to the terminal.</p>"
        );

        console.log("Tokens saved successfully!");
        console.log(`  Token file: ${TOKEN_FILE}`);
        console.log(`  Scopes: ${saved.scope}`);
        if (saved.expires_at) {
          const expiresIn = Math.round((saved.expires_at - Date.now()) / 1000 / 60);
          console.log(`  Access token expires in: ${expiresIn} minutes`);
        }
        console.log(`  Refresh token: present (does not expire)`);
        console.log("");
        console.log("The orchestrator will auto-refresh when the access token expires.");
        console.log("You should not need to run this setup again unless you revoke access.");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
        console.error(`\nToken exchange failed: ${err.message}`);
      }

      server.close();
      resolve();
    });

    server.listen(port, () => {
      console.log(`Callback server listening on port ${port}`);

      const openCmd =
        process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "start" : "xdg-open";
      try {
        execSyncFn(`${openCmd} "${authUrl.toString()}"`, { stdio: "ignore" });
      } catch {
        // User will need to open manually
      }
    });
  });
}

// ─── CLI entry point ────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === "setup") {
  runSetup().catch((err) => {
    console.error("Setup failed:", err.message);
    process.exit(1);
  });
} else if (args[0] === "check") {
  try {
    const token = await getLinearToken();
    console.log("Token is valid.");

    const body = JSON.stringify({ query: "{ viewer { id name email } }" });
    const res = await httpsRequest("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, body);

    const data = res.json();
    if (data.data?.viewer) {
      console.log(`Authenticated as: ${data.data.viewer.name} (${data.data.viewer.email})`);
    } else {
      console.error("Token valid but query failed:", JSON.stringify(data.errors));
    }
  } catch (err) {
    console.error("Check failed:", err.message);
    process.exit(1);
  }
} else if (args.length === 0 && process.argv[1]?.endsWith("linear-oauth.mjs")) {
  console.log("Usage:");
  console.log("  node linear-oauth.mjs setup   — Authorize and store tokens");
  console.log("  node linear-oauth.mjs check   — Verify stored tokens work");
  console.log("");
  console.log("Environment variables required:");
  console.log("  LINEAR_CLIENT_ID       — OAuth app client ID");
  console.log("  LINEAR_CLIENT_SECRET   — OAuth app client secret");
  console.log("");
  console.log("Optional:");
  console.log(`  LINEAR_REDIRECT_URI    — Callback URL (default: ${LINEAR_REDIRECT_URI})`);
  console.log(`  LINEAR_SCOPES          — OAuth scopes (default: ${LINEAR_SCOPES})`);
  console.log(`  LINEAR_TOKEN_FILE      — Where to store tokens (default: ${TOKEN_FILE})`);
}
