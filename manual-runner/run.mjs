#!/usr/bin/env node
// =============================================================================
// Manual Runner — Ad-hoc Claude Code task in a sandboxed container
//
// Spin up a container, check out a branch, and give it custom instructions.
// Uses your Claude Code OAuth login or an API key.
//
// Usage:
//   node run.mjs --branch feature/my-thing --instructions "Add unit tests for auth.ts"
//   node run.mjs -b main -i "Refactor the database module" --model opus
//   node run.mjs -b fix/login -i "$(cat instructions.md)"
//   node run.mjs --interactive  (prompts you for branch + instructions)
//
// Auth: reads ANTHROPIC_API_KEY from .env, or falls back to your Claude Code
//       login (macOS Keychain / ~/.claude/.credentials.json)
// =============================================================================

import { execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createInterface } from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Also load from the linear-task-runner .env as fallback for shared config
const ltEnv = join(__dirname, "..", "linear-task-runner", ".env");
if (existsSync(ltEnv)) {
  const lines = readFileSync(ltEnv, "utf8").split("\n");
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

// ─── Configuration ──────────────────────────────────────────────────────────
const GIT_PROVIDER = process.env.GIT_PROVIDER || "gitlab";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || "";
const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID || "";
const REPO_URL = process.env.REPO_URL || "";
const LOCAL_REPO_PATH = process.env.LOCAL_REPO_PATH || "";
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "claude-task-runner";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "50");
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || "1800000");
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";
const STAGING_DIR = process.env.STAGING_DIR || "/tmp/task-staging";

function ts() {
  return new Date().toISOString().slice(0, 19);
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Claude auth ────────────────────────────────────────────────────────────
function getClaudeOAuthToken() {
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const creds = JSON.parse(raw);
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) {
        log("Auth: using Claude OAuth token from macOS Keychain");
        return token;
      }
    } catch {}
  }

  const credPaths = [
    join(process.env.CLAUDE_CONFIG_DIR || "", ".credentials.json"),
    join(process.env.HOME || "", ".claude", ".credentials.json"),
  ].filter(Boolean);

  for (const p of credPaths) {
    if (existsSync(p)) {
      try {
        const creds = JSON.parse(readFileSync(p, "utf8"));
        const token = creds?.claudeAiOauth?.accessToken;
        if (token) {
          log(`Auth: using Claude OAuth token from ${p}`);
          return token;
        }
      } catch {}
    }
  }
  return null;
}

let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
if (!ANTHROPIC_API_KEY) {
  const oauthToken = getClaudeOAuthToken();
  if (oauthToken) ANTHROPIC_API_KEY = oauthToken;
}

if (!ANTHROPIC_API_KEY) {
  console.error("No Anthropic credentials found. Either:");
  console.error("  1. Set ANTHROPIC_API_KEY in .env or linear-task-runner/.env");
  console.error("  2. Log in with: claude login");
  process.exit(1);
}

if (!LOCAL_REPO_PATH && !REPO_URL) {
  console.error("Set LOCAL_REPO_PATH or REPO_URL in .env");
  process.exit(1);
}

// ─── Parse CLI arguments ────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { branch: "", instructions: "", model: CLAUDE_MODEL, interactive: false, newBranch: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--branch": case "-b":
        parsed.branch = args[++i];
        break;
      case "--new-branch": case "-nb":
        parsed.branch = args[++i];
        parsed.newBranch = true;
        break;
      case "--instructions": case "-i":
        parsed.instructions = args[++i];
        break;
      case "--model": case "-m":
        parsed.model = args[++i];
        break;
      case "--interactive":
        parsed.interactive = true;
        break;
      case "--help": case "-h":
        console.log(`Usage: node run.mjs [options]

Options:
  -b,  --branch <name>        Branch to check out (existing)
  -nb, --new-branch <name>    Create and check out a new branch from main
  -i,  --instructions <text>  What to work on (can be multi-line, use "$(cat file.md)")
  -m,  --model <model>        Claude model (default: ${CLAUDE_MODEL})
       --interactive           Prompt for branch and instructions
  -h,  --help                 Show this help

Examples:
  node run.mjs -b feature/auth -i "Add unit tests for the auth middleware"
  node run.mjs -nb fix/login-bug -i "The login button doesn't work on Firefox"
  node run.mjs -b main -i "$(cat tasks/refactor-db.md)" --model opus
  node run.mjs --interactive`);
        process.exit(0);
    }
  }
  return parsed;
}

async function promptUser(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Staging copy ───────────────────────────────────────────────────────────
function prepareStagingCopy(label) {
  const stagingPath = join(STAGING_DIR, `manual-${label}-${randomUUID().slice(0, 8)}`);
  mkdirSync(stagingPath, { recursive: true });

  if (LOCAL_REPO_PATH) {
    log(`Copying local repo to staging...`);
    const start = Date.now();
    execSync(`cp -r "${LOCAL_REPO_PATH}" "${stagingPath}/repo"`, { stdio: "pipe" });
    execSync(`chmod -R 777 "${stagingPath}/repo"`, { stdio: "pipe" });
    log(`Copy took ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }

  // Reset to latest main
  const repoDir = `${stagingPath}/repo`;
  if (REPO_URL) {
    try {
      execSync(`git -C "${repoDir}" remote set-url origin "${REPO_URL}"`, { stdio: "pipe" });
    } catch {}
  }
  try {
    execSync(`git -C "${repoDir}" reset --hard HEAD`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" clean -fd`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" fetch origin`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" checkout ${DEFAULT_BRANCH}`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" reset --hard origin/${DEFAULT_BRANCH}`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" clean -fd`, { stdio: "pipe" });
  } catch (err) {
    log(`Warning: could not reset to main: ${err.message}`);
  }

  return stagingPath;
}

// ─── Rescue unpushed work ───────────────────────────────────────────────────
function rescueUnpushedWork(stagingPath) {
  if (!stagingPath) return;
  const repoPath = join(stagingPath, "repo");
  if (!existsSync(join(repoPath, ".git"))) return;

  try {
    const branch = execSync(`git -C "${repoPath}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf8", stdio: "pipe"
    }).trim();

    const status = execSync(`git -C "${repoPath}" status --porcelain`, {
      encoding: "utf8", stdio: "pipe"
    }).trim();

    if (status) {
      log(`Found uncommitted changes — committing as WIP`);
      execSync(`git -C "${repoPath}" add -A`, { stdio: "pipe" });
      execSync(`git -C "${repoPath}" commit -m "WIP: rescued uncommitted work"`, {
        stdio: "pipe",
        env: { ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_USER_NAME || "claude-task-runner",
          GIT_AUTHOR_EMAIL: process.env.GIT_USER_EMAIL || "claude-task-runner@automated",
          GIT_COMMITTER_NAME: process.env.GIT_USER_NAME || "claude-task-runner",
          GIT_COMMITTER_EMAIL: process.env.GIT_USER_EMAIL || "claude-task-runner@automated" },
      });
    }

    // Check for unpushed commits
    let hasCommits = false;
    for (const base of ["main", "master"]) {
      try {
        const count = execSync(`git -C "${repoPath}" rev-list --count ${base}..${branch}`, {
          encoding: "utf8", stdio: "pipe"
        }).trim();
        if (parseInt(count) > 0) hasCommits = true;
        break;
      } catch {}
    }

    if (!hasCommits) return;

    try {
      execSync(`git -C "${repoPath}" push -u origin ${branch}`, { stdio: "pipe" });
      log(`Rescued work pushed to origin/${branch}`);
    } catch (err) {
      log(`Could not push rescued work: ${err.message}`);
    }
  } catch (err) {
    log(`Could not rescue work: ${err.message}`);
  }
}

// ─── Run container ──────────────────────────────────────────────────────────
function runContainer(opts) {
  return new Promise((resolve, reject) => {
    const { branch, newBranch, instructions, model, stagingPath } = opts;
    const containerName = `manual-${branch.replace(/\//g, "-")}-${randomUUID().slice(0, 8)}`;
    const cliName = GIT_PROVIDER === "github" ? "gh" : "glab";
    const mrTerm = GIT_PROVIDER === "github" ? "pull request" : "merge request";

    const branchInstruction = newBranch
      ? `1. Create and switch to a NEW branch: git checkout -b ${branch}`
      : `1. Check out the branch: git checkout ${branch} && git pull origin ${branch}`;

    const prompt = `You are an autonomous developer working on a task.

${instructions}

Instructions:
${branchInstruction}
2. Read the codebase to understand the relevant code
3. Implement the requested changes following this save pattern:
   - After every meaningful change, commit AND push:
     git add -A && git commit -m "[what you just did]" && git push -u origin ${branch}
   - Do NOT batch up changes — commit and push after each logical step
   - This ensures no work is lost if the session ends unexpectedly
4. Write or update tests if appropriate
5. Run the existing test suite to verify nothing is broken
6. If you cannot complete the task, still commit and push whatever progress you've made with a WIP commit
7. Optionally create a draft ${mrTerm} using ${cliName} CLI if the work is ready for review`;

    const dockerArgs = [
      "run", "--rm",
      "--name", containerName,
      "--cap-add=NET_ADMIN",
      "-e", `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
      "-e", `GIT_PROVIDER=${GIT_PROVIDER}`,
      ...(process.env.GIT_USER_NAME ? ["-e", `GIT_USER_NAME=${process.env.GIT_USER_NAME}`] : []),
      ...(process.env.GIT_USER_EMAIL ? ["-e", `GIT_USER_EMAIL=${process.env.GIT_USER_EMAIL}`] : []),
      "--memory=4g", "--cpus=2",
    ];

    if (LOCAL_REPO_PATH && stagingPath) {
      dockerArgs.push(
        "-v", `${stagingPath}/repo:/workspace/repo`,
        "-e", `REPO_URL=${REPO_URL || ""}`,
        "-e", "SKIP_CLONE=1",
      );
    } else {
      dockerArgs.push("-e", `REPO_URL=${REPO_URL}`);
    }

    if (GIT_PROVIDER === "github") {
      dockerArgs.push(
        "-e", `GITHUB_TOKEN=${GITHUB_TOKEN}`,
        "-e", `GH_TOKEN=${GITHUB_TOKEN}`,
        "-e", `GITHUB_REPO=${GITHUB_REPO}`,
      );
    } else {
      dockerArgs.push(
        "-e", `GITLAB_TOKEN=${GITLAB_TOKEN}`,
        "-e", `GITLAB_URL=${GITLAB_URL}`,
        "-e", `GITLAB_PROJECT_ID=${GITLAB_PROJECT_ID}`,
      );
    }

    if (process.env.CUSTOM_CA_CERT) {
      dockerArgs.push("-e", `CUSTOM_CA_CERT=${process.env.CUSTOM_CA_CERT}`);
    }

    dockerArgs.push(
      DOCKER_IMAGE,
      "claude", "-p", prompt,
      "--dangerously-skip-permissions",
      "--model", model,
      "--max-turns", String(MAX_TURNS),
      "--verbose",
      "--output-format", "stream-json",
    );

    log(`Spawning container: ${containerName}`);
    log(`Branch: ${branch} (${newBranch ? "new" : "existing"})`);
    log(`Model: ${model} | Max turns: ${MAX_TURNS} | Timeout: ${TASK_TIMEOUT_MS / 1000}s`);

    let stdout = "";
    let stderr = "";
    const spawnStart = Date.now();

    const proc = spawn("docker", dockerArgs, { timeout: TASK_TIMEOUT_MS });

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                log(`Claude: ${block.text.slice(0, 200)}`);
              } else if (block.type === "tool_use") {
                log(`Tool: ${block.name}${block.input?.command ? ` → ${block.input.command.slice(0, 100)}` : ""}`);
              }
            }
          } else if (event.type === "result") {
            log(`Result: ${(event.result || "").slice(0, 200)}`);
          }
        } catch {}
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      const elapsed = ((Date.now() - spawnStart) / 1000).toFixed(0);
      log(`Container exited with code ${code} after ${elapsed}s`);
      resolve({ exitCode: code, stdout, stderr });
    });

    proc.on("error", reject);
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();

  // Interactive mode
  if (args.interactive || (!args.branch && !args.instructions)) {
    args.branch = await promptUser("Branch to check out (or new branch name): ");
    if (!args.branch) {
      console.error("Branch is required");
      process.exit(1);
    }
    const isNew = await promptUser("Is this a new branch? (y/N): ");
    args.newBranch = isNew.toLowerCase() === "y";

    console.log("Enter instructions (end with an empty line):");
    const lines = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of rl) {
      if (line === "") break;
      lines.push(line);
    }
    args.instructions = lines.join("\n");

    if (!args.instructions) {
      console.error("Instructions are required");
      process.exit(1);
    }
  }

  if (!args.branch || !args.instructions) {
    console.error("Both --branch and --instructions are required (or use --interactive)");
    console.error("Run with --help for usage");
    process.exit(1);
  }

  log("═══════════════════════════════════════════════════════");
  log("  Manual Runner");
  log("═══════════════════════════════════════════════════════");
  log(`Branch: ${args.branch} (${args.newBranch ? "new" : "existing"})`);
  log(`Instructions: ${args.instructions.slice(0, 200)}${args.instructions.length > 200 ? "..." : ""}`);
  log(`Model: ${args.model}`);
  log(`Repo: ${LOCAL_REPO_PATH || REPO_URL}`);

  // Build Docker image if not already built
  const dockerfilePath = join(__dirname, "..", "linear-task-runner");
  log("Ensuring Docker image is built...");
  try {
    execSync(`docker image inspect ${DOCKER_IMAGE} > /dev/null 2>&1`, { stdio: "pipe" });
    log("Docker image found.");
  } catch {
    log("Building Docker image...");
    execSync(`docker build -t ${DOCKER_IMAGE} "${dockerfilePath}"`, { stdio: "inherit" });
  }

  // Prepare staging copy
  let stagingPath = null;
  if (LOCAL_REPO_PATH) {
    stagingPath = prepareStagingCopy(args.branch.replace(/\//g, "-"));
  }

  try {
    const result = await runContainer({
      branch: args.branch,
      newBranch: args.newBranch,
      instructions: args.instructions,
      model: args.model,
      stagingPath,
    });

    rescueUnpushedWork(stagingPath);

    if (result.exitCode === 0) {
      log("Task completed successfully.");
    } else {
      log(`Task exited with code ${result.exitCode}.`);
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    rescueUnpushedWork(stagingPath);
  } finally {
    // Clean up staging
    if (stagingPath && existsSync(stagingPath)) {
      try {
        execSync(`rm -rf "${stagingPath}"`, { stdio: "pipe" });
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
