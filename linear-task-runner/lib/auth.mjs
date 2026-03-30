import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Resolve the Claude OAuth access token from the host platform's credential
 * store, falling back to the credentials JSON file in common locations.
 * Returns null if no token is found (caller should check ANTHROPIC_API_KEY first).
 * @param {(msg: string) => void} [log]
 */
export function getClaudeOAuthToken(log = console.log) {
  // macOS: read from Keychain
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      if (token) {
        log("Auth: using Claude OAuth token from macOS Keychain");
        return token;
      }
    } catch { /* not in Keychain */ }
  }

  // Windows: try Credential Manager via PowerShell
  // Requires: Install-Module CredentialManager -Scope CurrentUser
  if (process.platform === "win32") {
    try {
      const raw = execSync(
        `powershell -NoProfile -Command "` +
        `(Get-StoredCredential -Target 'Claude Code-credentials').Password | ` +
        `ConvertFrom-SecureString -AsPlainText"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
      if (token) {
        log("Auth: using Claude OAuth token from Windows Credential Manager");
        return token;
      }
    } catch { /* module not installed or credential not found */ }
  }

  // All platforms: fall back to credentials file in common locations
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const credPaths = [
    process.env.CLAUDE_CONFIG_DIR && join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"),
    home && join(home, ".claude", ".credentials.json"),
    process.env.APPDATA && join(process.env.APPDATA, "Claude Code", ".credentials.json"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Claude Code", ".credentials.json"),
  ].filter(Boolean);

  for (const credPath of credPaths) {
    if (existsSync(credPath)) {
      try {
        const token = JSON.parse(readFileSync(credPath, "utf8"))?.claudeAiOauth?.accessToken;
        if (token) {
          log(`Auth: using Claude OAuth token from ${credPath}`);
          return token;
        }
      } catch { /* invalid JSON or missing field */ }
    }
  }

  return null;
}

/**
 * Resolve Codex (OpenAI) auth from OPENAI_API_KEY env var or the
 * credentials stored by `codex login` at ~/.codex/auth.json.
 * Returns { mode, token, authJson? } or null.
 * @param {(msg: string) => void} [log]
 */
export function getCodexAuth(log = console.log) {
  if (process.env.OPENAI_API_KEY) {
    return { mode: "api-key", token: process.env.OPENAI_API_KEY };
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const authPath = join(home, ".codex", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth.tokens?.access_token) {
        log(`Auth: using Codex OAuth token from ${authPath}`);
        return { mode: "oauth", token: auth.tokens.access_token, authJson: auth };
      }
      if (auth.OPENAI_API_KEY) {
        log(`Auth: using Codex API key from ${authPath}`);
        return { mode: "api-key", token: auth.OPENAI_API_KEY };
      }
    } catch {}
  }

  return null;
}

/**
 * Resolve agent credentials based on AGENT_PROVIDER.
 * Returns { provider, apiKey, authMode, codexAuthJson? } or exits.
 * @param {(msg: string) => void} [log]
 */
export function resolveAgentAuth(log = console.log) {
  const provider = process.env.AGENT_PROVIDER || "claude";
  let apiKey = "";
  let authMode = "api-key";
  let codexAuthJson = null;

  if (provider === "codex") {
    const codexAuth = getCodexAuth(log);
    if (codexAuth) {
      apiKey = codexAuth.token;
      authMode = codexAuth.mode;
      if (codexAuth.authJson) codexAuthJson = codexAuth.authJson;
    }
  } else {
    apiKey = process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      const oauthToken = getClaudeOAuthToken(log);
      if (oauthToken) {
        apiKey = oauthToken;
        authMode = "oauth";
      }
    }
  }

  if (!apiKey) {
    if (provider === "codex") {
      console.error("No Codex credentials. Set OPENAI_API_KEY or run: codex login");
    } else {
      console.error("No Claude credentials. Set ANTHROPIC_API_KEY or run: claude login");
    }
    process.exit(1);
  }

  return { provider, apiKey, authMode, codexAuthJson };
}
