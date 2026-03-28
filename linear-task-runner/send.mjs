#!/usr/bin/env node
// =============================================================================
// send.mjs — Send an instruction to a running Claude container mid-task
//
// Usage:
//   node send.mjs <task-identifier> "<message>"
//   node send.mjs F2-46 "Actually, skip the migration — address it in a follow-up ticket"
//   node send.mjs F2-46 "$(cat extra-context.md)"
//
// The message is written to /workspace/signals/inbox.txt inside the container.
// Claude checks this file before each major step and acts on it.
//
// List running tasks:
//   node send.mjs --list
// =============================================================================

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvFile } from "./lib/env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(__dirname, ".env"));

const TASK_STATE_FILE = join(__dirname, ".task-state.json");

function loadTaskState() {
  if (!existsSync(TASK_STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(TASK_STATE_FILE, "utf8")); }
  catch { return {}; }
}

function listRunning() {
  const state = loadTaskState();
  const active = Object.entries(state).filter(([, v]) => v.status === "active");
  if (active.length === 0) {
    console.log("No active tasks.");
    return;
  }
  console.log("Active tasks:");
  for (const [id, info] of active) {
    console.log(`  ${id}  container: ${info.containerName || "unknown"}  started: ${info.startedAt}`);
  }
}

function send(taskIdentifier, message) {
  const state = loadTaskState();
  const info = state[taskIdentifier.toUpperCase()] || state[taskIdentifier];

  if (!info || info.status !== "active") {
    // Try matching case-insensitively
    const match = Object.entries(state).find(
      ([k, v]) => k.toLowerCase() === taskIdentifier.toLowerCase() && v.status === "active"
    );
    if (!match) {
      console.error(`No active task found for "${taskIdentifier}".`);
      console.error("Run: node send.mjs --list");
      process.exit(1);
    }
    return send(match[0], message);
  }

  const { containerName } = info;
  if (!containerName) {
    console.error(`Container name not recorded for task ${taskIdentifier}. Was it started with a recent version of orchestra?`);
    process.exit(1);
  }

  const escaped = message.replace(/'/g, `'\\''`);
  const cmd = `docker exec ${containerName} sh -c 'echo ${JSON.stringify(message)} >> /workspace/signals/inbox.txt'`;

  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(`✓ Message delivered to ${containerName} (${taskIdentifier})`);
    console.log(`  Claude will read it before its next major step.`);
  } catch (err) {
    console.error(`Failed to reach container "${containerName}".`);
    console.error(`Is the container still running? Try: docker ps | grep ${containerName}`);
    process.exit(1);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === "--list" || args[0] === "-l") {
  listRunning();
} else if (args.length >= 2) {
  send(args[0], args.slice(1).join(" "));
} else {
  console.log(`Usage:
  node send.mjs <task-id> "<message>"    Send a message to a running task
  node send.mjs --list                   List all active tasks and containers

Examples:
  node send.mjs F2-46 "Skip the migration, handle it in a follow-up"
  node send.mjs F2-46 "$(cat extra-context.md)"`);
}
