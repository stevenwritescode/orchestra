import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Load a .env file into process.env without overwriting existing values.
 * @param {string} envPath - absolute path to the .env file
 */
export function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

/**
 * Load .env from a directory, then fall back to a secondary path.
 * @param {string} primaryDir - directory containing the primary .env
 * @param {string} [fallbackPath] - optional absolute path to a fallback .env
 */
export function loadEnv(primaryDir, fallbackPath) {
  loadEnvFile(join(primaryDir, ".env"));
  if (fallbackPath) loadEnvFile(fallbackPath);
}
