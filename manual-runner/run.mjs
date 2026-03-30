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
import { loadEnv } from "../linear-task-runner/lib/env.mjs";
import { resolveAgentAuth } from "../linear-task-runner/lib/auth.mjs";
import { buildSkillsPromptSection } from "../linear-task-runner/lib/skills.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load local .env first, then fall back to linear-task-runner/.env for shared config
loadEnv(__dirname, join(__dirname, "..", "linear-task-runner", ".env"));

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
const CLAUDE_SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR || "";
const MAX_CONTEXT_RESETS = parseInt(process.env.MAX_CONTEXT_RESETS || "5");

function ts() {
  return new Date().toISOString().slice(0, 19);
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}


const AGENT = resolveAgentAuth(log);
const AGENT_PROVIDER = AGENT.provider;
const AGENT_API_KEY = AGENT.apiKey;
const CODEX_MODEL = process.env.CODEX_MODEL || "o3";
const CODEX_AUTH_JSON = AGENT.codexAuthJson;

if (!LOCAL_REPO_PATH && !REPO_URL) {
  console.error("Set LOCAL_REPO_PATH or REPO_URL in .env");
  process.exit(1);
}

// ─── Parse CLI arguments ────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const defaultModel = AGENT_PROVIDER === "codex" ? CODEX_MODEL : CLAUDE_MODEL;
  const parsed = { branch: "", instructions: "", model: defaultModel, interactive: false, newBranch: false };

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
    const { branch, newBranch, instructions, model, stagingPath, runLabel, resumeNote } = opts;
    const containerName = `manual-${branch.replace(/\//g, "-")}-${randomUUID().slice(0, 8)}`;
    const cliName = GIT_PROVIDER === "github" ? "gh" : "glab";
    const mrTerm = GIT_PROVIDER === "github" ? "pull request" : "merge request";

    // Persistent signals dir for this run — survives context resets
    const signalsDir = join(
      __dirname, "..", ".orchestra", "runs",
      (runLabel || branch).replace(/[^a-z0-9-]/gi, "-").toLowerCase(), "signals"
    );
    mkdirSync(signalsDir, { recursive: true });
    try { execSync(`chmod -R 777 "${signalsDir}"`, { stdio: "pipe" }); } catch {}

    const branchInstruction = newBranch
      ? `1. Create and switch to a NEW branch: git checkout -b ${branch}`
      : `1. Check out the branch: git checkout ${branch} && git pull origin ${branch}`;

    const prompt = `You are an autonomous developer working on a task.

${instructions}
${buildSkillsPromptSection(CLAUDE_SKILLS_DIR, instructions, log)}
════════════════════════════════════════════════════════════
CONTEXT & SUB-AGENTS
════════════════════════════════════════════════════════════
You are running in a container with a finite context window. Manage it carefully:
- Use targeted reads: read specific line ranges, not entire files. Use grep/search first.
- Summarise tool output mentally — do not re-read results you already processed.
- Delegate independent subtasks to sub-agents using the Task tool. Sub-agents get a
  fresh context window. Always tell them the working branch is "${branch}".

INBOX (human instructions sent mid-task):
- Before each major step, check /workspace/signals/inbox.txt for new instructions:
    [ -s /workspace/signals/inbox.txt ] && cat /workspace/signals/inbox.txt && truncate -s 0 /workspace/signals/inbox.txt
- If the file has content, read it, acknowledge it, and incorporate it before continuing.

SPEC FILE & CONTEXT COMPACTION:
Your session has a limit of ${MAX_TURNS} turns. At the very start, BEFORE any other work,
create /workspace/signals/spec.md:

  # Task: ${branch}
  ## Objective
  <one-sentence summary of what needs to be done>
  ## Steps
  - [ ] Step 1: ...
  - [ ] Step 2: ...
  ## Progress Notes
  <leave blank initially>

After completing each step: check it off ([ ] → [x]) and add a brief Progress Notes entry.

The runner monitors your turn count and context window. When you approach either limit,
it will send a CONTEXT WARNING to your inbox. When you receive one:
1. Finish the step you are currently on
2. Check it off in spec.md and note what comes next
3. Commit and push any uncommitted changes
4. Checkpoint: printf 'checkpoint' > /workspace/signals/checkpoint
5. Exit immediately — a fresh session will read your spec and resume

You can also checkpoint proactively any time you estimate fewer than
${Math.ceil(MAX_TURNS * 0.2)} turns remain and you still have steps left.
${resumeNote ? `\n${resumeNote}` : ""}════════════════════════════════════════════════════════════

Instructions:
${branchInstruction}
2. Read the codebase to understand the relevant code — use targeted reads and grep,
   not full-file reads
3. Implement the requested changes following this save pattern:
   - After every meaningful change, commit AND push:
     git add -A && git commit -m "[what you just did]" && git push -u origin ${branch}
   - Do NOT batch up changes — commit and push after each logical step
   - This ensures no work is lost if the session ends unexpectedly
4. Write or update tests if appropriate
5. Run the existing test suite to verify nothing is broken
6. If you cannot complete the task, still commit and push whatever progress you've made with a WIP commit
7. Optionally create a draft ${mrTerm} using ${cliName} CLI if the work is ready for review
8. Use ${cliName} CLI for all ${GIT_PROVIDER === "github" ? "GitHub" : "GitLab"} operations — do NOT make direct API calls`;

    const dockerArgs = [
      "run", "--rm",
      "--name", containerName,
      "--cap-add=NET_ADMIN",
      "-e", `AGENT_PROVIDER=${AGENT_PROVIDER}`,
      ...(AGENT_PROVIDER === "codex"
        ? ["-e", `OPENAI_API_KEY=${AGENT_API_KEY}`]
        : ["-e", `ANTHROPIC_API_KEY=${AGENT_API_KEY}`]),
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

    // Always mount the persistent signals dir (spec, checkpoint, inbox)
    dockerArgs.push("-v", `${signalsDir}:/workspace/signals`);

    if (CLAUDE_SKILLS_DIR && existsSync(CLAUDE_SKILLS_DIR)) {
      dockerArgs.push("-v", `${CLAUDE_SKILLS_DIR}:/home/claude-runner/.claude/commands:ro`);
    }

    // For Codex OAuth: mount auth.json
    if (AGENT_PROVIDER === "codex" && CODEX_AUTH_JSON) {
      const codexAuthDir = join(STAGING_DIR, `codex-auth-${containerName}`);
      mkdirSync(codexAuthDir, { recursive: true });
      writeFileSync(join(codexAuthDir, "auth.json"), JSON.stringify(CODEX_AUTH_JSON, null, 2));
      execSync(`chmod -R 777 "${codexAuthDir}"`, { stdio: "pipe" });
      dockerArgs.push("-v", `${codexAuthDir}:/home/claude-runner/.codex:rw`);
    }

    if (AGENT_PROVIDER === "codex") {
      dockerArgs.push(
        DOCKER_IMAGE,
        "codex", "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model", model === CLAUDE_MODEL ? CODEX_MODEL : model,
        "--json",
        "--ephemeral",
        prompt,
      );
    } else {
      dockerArgs.push(
        DOCKER_IMAGE,
        "claude", "-p", prompt,
        "--dangerously-skip-permissions",
        "--model", model,
        "--max-turns", String(MAX_TURNS),
        "--verbose",
        "--output-format", "stream-json",
      );
    }

    log(`Spawning container: ${containerName}`);
    log(`Agent: ${AGENT_PROVIDER} | Branch: ${branch} (${newBranch ? "new" : "existing"})`);
    log(`Model: ${model} | Max turns: ${MAX_TURNS} | Timeout: ${TASK_TIMEOUT_MS / 1000}s`);

    let stdout = "";
    let stderr = "";
    let turnCount = 0;
    let contextWarned = false;
    const CONTEXT_WARN_TOKENS = Math.floor(200000 * 0.8);
    const TURN_WARN_THRESHOLD = Math.floor(MAX_TURNS * 0.8);
    const spawnStart = Date.now();

    const sendContextWarning = (reason) => {
      if (contextWarned) return;
      contextWarned = true;
      const msg = `CONTEXT WARNING: ${reason}. Finish your current step, update /workspace/signals/spec.md, commit and push, then checkpoint: printf 'checkpoint' > /workspace/signals/checkpoint`;
      try {
        writeFileSync(join(signalsDir, "inbox.txt"), msg + "\n", { flag: "a" });
        log(`Context warning → agent inbox (${reason})`);
      } catch {}
    };

    const proc = spawn("docker", dockerArgs, { timeout: TASK_TIMEOUT_MS });

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            turnCount++;
            const inputTokens = event.message?.usage?.input_tokens ?? 0;

            if (!contextWarned) {
              if (inputTokens > CONTEXT_WARN_TOKENS) {
                sendContextWarning(`context window ~${Math.round(inputTokens / 1000)}k / 200k tokens used`);
              } else if (turnCount >= TURN_WARN_THRESHOLD) {
                sendContextWarning(`turn ${turnCount}/${MAX_TURNS} reached (~80% of budget)`);
              }
            }

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
      resolve({ exitCode: code, stdout, stderr, signalsDir });
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

  const runLabel = `${args.branch.replace(/\//g, "-")}-${Date.now()}`;

  try {
    let contextResets = 0;
    let result;

    while (true) {
      const resumeNote = contextResets > 0
        ? `RESUMING FROM CONTEXT RESET (session ${contextResets + 1}/${MAX_CONTEXT_RESETS + 1}):\nRead /workspace/signals/spec.md and continue from the first unchecked step. Do NOT redo completed steps.\n`
        : "";

      result = await runContainer({
        branch: args.branch,
        newBranch: args.newBranch,
        instructions: args.instructions,
        model: args.model,
        stagingPath,
        runLabel,
        resumeNote,
      });

      if (result.exitCode !== 0) {
        log(`Task exited with code ${result.exitCode}.`);
        break;
      }

      const checkpointFile = join(result.signalsDir, "checkpoint");
      if (existsSync(checkpointFile)) {
        contextResets++;
        log(`Context checkpoint — reset ${contextResets}/${MAX_CONTEXT_RESETS}`);
        try { execSync(`rm -f "${checkpointFile}"`, { stdio: "pipe" }); } catch {}
        if (contextResets >= MAX_CONTEXT_RESETS) {
          log(`Max context resets (${MAX_CONTEXT_RESETS}) reached — stopping`);
          break;
        }
        continue;
      }

      log("Task completed successfully.");
      break;
    }

    rescueUnpushedWork(stagingPath);
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
