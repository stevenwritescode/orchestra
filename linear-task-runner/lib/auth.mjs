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
