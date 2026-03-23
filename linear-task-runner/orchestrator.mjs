#!/usr/bin/env node
// =============================================================================
// Linear Task Runner — Orchestrator (GitLab Edition)
//
// Polls Linear for tasks matching a filter (e.g. label "autofix", status "Todo"),
// then for each task:
//   1. Spins up a fresh Docker container with Claude Code
//   2. Claude Code runs with --dangerously-skip-permissions (safe in container)
//   3. Claude reads the codebase, implements the task, runs tests, opens an MR
//   4. Updates the Linear issue with the result (MR link or failure notes)
//   5. Destroys the container
//
// Usage:
//   LINEAR_API_KEY=lin_api_... ANTHROPIC_API_KEY=sk-ant-... node orchestrator.mjs
// =============================================================================

import { execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

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

// OAuth support: import the token manager for auto-refreshing Linear tokens.
// Resolve relative to THIS file's directory, not CWD.
// Use pathToFileURL so dynamic import() works cross-platform.
let getLinearToken;
try {
  const oauthUrl = pathToFileURL(join(__dirname, "linear-oauth.mjs")).href;
  ({ getLinearToken } = await import(oauthUrl));
} catch {
  // linear-oauth.mjs not available — that's fine if using API key
}

// ─── Configuration ──────────────────────────────────────────────────────────
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";
const LINEAR_AUTH_MODE = LINEAR_API_KEY ? "api-key" : "oauth";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const REPO_URL = process.env.REPO_URL;

// Local repo support: bind-mount a pre-configured local repo instead of cloning
// Set LOCAL_REPO_PATH to the absolute path of your local checkout
const LOCAL_REPO_PATH = process.env.LOCAL_REPO_PATH || "";

const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "claude-task-runner";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "25");
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || "600000");
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";

// Backend Docker testing: the orchestrator can build and test your backend
// container after the agent makes changes, then feed results back.
// Set BACKEND_DOCKER_COMPOSE to the path of your backend's docker-compose.yml
// (relative to the repo root). The orchestrator will run it on the host.
const BACKEND_DOCKER_COMPOSE = process.env.BACKEND_DOCKER_COMPOSE || "";
const BACKEND_SERVICE_NAME = process.env.BACKEND_SERVICE_NAME || "backend";
const BACKEND_TEST_CMD = process.env.BACKEND_TEST_CMD || "docker compose run --rm backend npm test";
const BACKEND_HEALTH_URL = process.env.BACKEND_HEALTH_URL || "";
const BACKEND_HEALTH_TIMEOUT_MS = parseInt(process.env.BACKEND_HEALTH_TIMEOUT_MS || "30000");
const MAX_FIX_ITERATIONS = parseInt(process.env.MAX_FIX_ITERATIONS || "3");

// Live backend access: the agent can curl the backend directly.
// The orchestrator starts the backend before the agent, and watches for
// rebuild signals from the agent during execution.
const BACKEND_LIVE_ACCESS = process.env.BACKEND_LIVE_ACCESS === "true";
const BACKEND_PORT = process.env.BACKEND_PORT || "3000";
const SIGNAL_POLL_MS = 2000; // how often to check for rebuild signals

// Staging directory for extracting agent changes before backend testing
const STAGING_DIR = process.env.STAGING_DIR || "/tmp/task-staging";

// Linear filter
const LINEAR_LABEL = process.env.LINEAR_LABEL || "autofix";
const LINEAR_STATUS = process.env.LINEAR_STATUS || "Todo";

if (!ANTHROPIC_API_KEY || !GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
  console.error("Missing required env vars: ANTHROPIC_API_KEY, GITLAB_TOKEN, GITLAB_PROJECT_ID");
  process.exit(1);
}
if (!LINEAR_API_KEY && !getLinearToken) {
  console.error("Linear auth: set LINEAR_API_KEY, or set LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET and run 'node linear-oauth.mjs setup'");
  process.exit(1);
}
if (!REPO_URL && !LOCAL_REPO_PATH) {
  console.error("Either REPO_URL or LOCAL_REPO_PATH must be set");
  process.exit(1);
}

// ─── Linear GraphQL Client ─────────────────────────────────────────────────
// Supports two auth modes:
//   1. API key: Authorization: lin_api_...  (direct, no Bearer prefix)
//   2. OAuth:   Authorization: Bearer <access_token>  (auto-refreshing)
async function getLinearAuthHeader() {
  if (LINEAR_AUTH_MODE === "api-key") {
    return LINEAR_API_KEY;
  }
  // OAuth mode: get a (possibly refreshed) access token
  const token = await getLinearToken();
  return `Bearer ${token}`;
}

async function linearQuery(query, variables = {}) {
  const authHeader = await getLinearAuthHeader();

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    // If we get a 401 with OAuth, the refresh token may be revoked
    if (res.status === 401 && LINEAR_AUTH_MODE === "oauth") {
      throw new Error(
        `Linear auth failed (401). Your OAuth tokens may be revoked. ` +
        `Re-run: node linear-oauth.mjs setup\n${text}`
      );
    }
    throw new Error(`Linear API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// ─── Fetch tasks from Linear ────────────────────────────────────────────────
async function fetchPendingTasks() {
  const data = await linearQuery(`
    query PendingTasks($labelName: String!, $statusName: String!) {
      issues(
        filter: {
          labels: { name: { eq: $labelName } }
          state: { name: { eq: $statusName } }
        }
        first: 10
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          description
          priority
          labels { nodes { name } }
          assignee { name }
          project { name }
          team { key }
          url
        }
      }
    }
  `, {
    labelName: LINEAR_LABEL,
    statusName: LINEAR_STATUS,
  });

  return data.issues.nodes;
}

// ─── Update Linear issue status ─────────────────────────────────────────────
async function updateIssueStatus(issueId, statusName) {
  const statesData = await linearQuery(`
    query States {
      workflowStates(filter: { name: { eq: "${statusName}" } }) {
        nodes { id name }
      }
    }
  `);

  const state = statesData.workflowStates.nodes[0];
  if (!state) {
    console.error(`Could not find workflow state: ${statusName}`);
    return;
  }

  await linearQuery(`
    mutation UpdateIssue($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `, { id: issueId, stateId: state.id });
}

// ─── Add comment to Linear issue ────────────────────────────────────────────
async function addIssueComment(issueId, body) {
  await linearQuery(`
    mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `, { issueId, body });
}

// ─── GitLab API helper ──────────────────────────────────────────────────────
async function gitlabApi(method, path, body = null) {
  const encodedProject = encodeURIComponent(GITLAB_PROJECT_ID);
  const url = `${GITLAB_URL}/api/v4/projects/${encodedProject}${path}`;

  const options = {
    method,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GitLab API ${method} ${path}: ${res.status} ${text}`);
  }

  return JSON.parse(text);
}

// ─── Check if an MR exists for this task ────────────────────────────────────
async function checkForMR(taskIdentifier) {
  try {
    const mrs = await gitlabApi("GET",
      `/merge_requests?state=opened&search=${encodeURIComponent(taskIdentifier)}&per_page=1`
    );
    return mrs.length > 0 ? mrs[0] : null;
  } catch {
    return null;
  }
}

// ─── Prepare a staging copy of the local repo ───────────────────────────────
// Creates a clean copy of the local repo for the container to work on.
// This avoids modifying your working tree directly.
function prepareStagingCopy(taskIdentifier) {
  const stagingPath = join(STAGING_DIR, `task-${taskIdentifier}-${randomUUID().slice(0, 8)}`);
  mkdirSync(stagingPath, { recursive: true });

  log(`[${taskIdentifier}] Copying local repo to staging: ${stagingPath}`);

  // Use git clone --local for efficiency (hardlinks where possible)
  execSync(`git clone --local "${LOCAL_REPO_PATH}" "${stagingPath}/repo"`, { stdio: "pipe" });

  // Ensure the remote points to the actual GitLab remote, not the local path
  if (REPO_URL) {
    execSync(`git -C "${stagingPath}/repo" remote set-url origin "${REPO_URL}"`, { stdio: "pipe" });
  }

  return stagingPath;
}

// ─── Run Claude Code in a sandboxed Docker container ────────────────────────
// Supports three repo modes:
//   1. REPO_URL mode: container clones from GitLab (original behavior)
//   2. LOCAL_REPO_PATH mode: host repo is copied to staging, bind-mounted in
// And two backend testing modes:
//   A. Orchestrator-mediated (BACKEND_DOCKER_COMPOSE): agent has no backend access,
//      orchestrator runs tests between agent sessions
//   B. Live access (BACKEND_LIVE_ACCESS): agent can curl the backend directly,
//      and signal the orchestrator to rebuild it mid-session
function runInContainer(task, extraPrompt = "") {
  return new Promise((resolve, reject) => {
    const containerName = `task-${task.identifier}-${randomUUID().slice(0, 8)}`;
    const branchName = `task/${task.identifier.toLowerCase()}`;
    let stagingPath = null;

    // Build the backend-specific prompt section
    let backendPromptSection = "";
    if (BACKEND_LIVE_ACCESS) {
      backendPromptSection = `
BACKEND TESTING — LIVE ACCESS MODE:
You have direct HTTP access to the backend running on the host machine.
Read the file /workspace/signals/backend-url to get the backend's base URL.
You can curl it directly to test your changes (e.g. curl $(cat /workspace/signals/backend-url)/api/health).

IMPORTANT: Do NOT run docker or docker compose commands — you don't have Docker access.

To request the orchestrator to REBUILD the backend with your latest code changes:
1. Commit your changes (git add + git commit)
2. Write a file: echo "rebuild" > /workspace/signals/rebuild
3. Wait for the orchestrator to finish: poll until /workspace/signals/rebuild-done exists
   (e.g. while [ ! -f /workspace/signals/rebuild-done ]; do sleep 2; done)
4. Remove the done signal: rm /workspace/signals/rebuild-done
5. Now the backend is running your latest code — test it again

This rebuild cycle lets you iterate: make changes → rebuild → test → repeat.`;
    } else if (BACKEND_DOCKER_COMPOSE) {
      backendPromptSection = `
IMPORTANT: Do NOT attempt to run docker or docker compose commands.
You do not have Docker access inside this container.
The orchestrator will build and test the backend container for you after you commit.
Focus on making code changes, running any non-Docker tests, and committing.`;
    }

    const prompt = `You are an autonomous developer working on a task from the project tracker.

Task: ${task.title}
Task ID: ${task.identifier}
Priority: ${task.priority || "none"}
${task.project ? `Project: ${task.project.name}` : ""}

Description:
${task.description || "No description provided."}
${extraPrompt ? `\nAdditional context:\n${extraPrompt}` : ""}

Instructions:
1. Read the codebase to understand the relevant code
2. Implement the requested changes
3. Write or update tests if appropriate
4. Run the existing test suite to verify nothing is broken
5. If tests pass, create a branch named "${branchName}", commit your changes, and push
6. Create a draft merge request using glab CLI with a clear description linking back to ${task.identifier}
7. If you cannot complete the task, write a detailed explanation of what blockers you hit
${backendPromptSection}

Commit message format: ${task.identifier}: [short description]
MR title format: Draft: ${task.identifier}: ${task.title}

Use glab CLI to create the MR. Link it to the task by including "${task.url}" in the MR body.
Example: glab mr create --draft --title "Draft: ${task.identifier}: ${task.title}" --description "..." --source-branch "${branchName}" --target-branch main`;

    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    const dockerArgs = [
      "run",
      "--rm",
      "--name", containerName,
      "--cap-add=NET_ADMIN",
      "-e", `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
      "-e", `GITLAB_TOKEN=${GITLAB_TOKEN}`,
      "-e", `GITLAB_URL=${GITLAB_URL}`,
      "-e", `GITLAB_PROJECT_ID=${GITLAB_PROJECT_ID}`,
      "--memory=4g",
      "--cpus=2",
    ];

    // Decide how the repo gets into the container
    if (LOCAL_REPO_PATH) {
      stagingPath = prepareStagingCopy(task.identifier);
      dockerArgs.push(
        "-v", `${stagingPath}/repo:/workspace/repo`,
        "-e", `REPO_URL=${REPO_URL || ""}`,
        "-e", "SKIP_CLONE=1",
      );
    } else {
      dockerArgs.push(
        "-e", `REPO_URL=${REPO_URL}`,
      );
    }

    // Live backend access: let the agent reach the backend on the host
    if (BACKEND_LIVE_ACCESS) {
      // --add-host ensures host.docker.internal resolves on Linux too
      dockerArgs.push(
        "--add-host=host.docker.internal:host-gateway",
        "-e", `BACKEND_PORT=${BACKEND_PORT}`,
      );

      // Mount signals directory for rebuild communication
      const signalsDir = stagingPath
        ? join(stagingPath, "signals")
        : join(STAGING_DIR, `signals-${containerName}`);
      mkdirSync(signalsDir, { recursive: true });
      dockerArgs.push(
        "-v", `${signalsDir}:/workspace/signals`,
      );
    }

    dockerArgs.push(
      DOCKER_IMAGE,
      "claude", "-p", escapedPrompt,
      "--dangerously-skip-permissions",
      "--model", CLAUDE_MODEL,
      "--max-turns", String(MAX_TURNS),
      "--output-format", "json",
    );

    log(`[${task.identifier}] Spawning container: ${containerName}`);
    if (LOCAL_REPO_PATH) {
      log(`[${task.identifier}] Using local repo: ${LOCAL_REPO_PATH} → staging: ${stagingPath}`);
    }
    if (BACKEND_LIVE_ACCESS) {
      log(`[${task.identifier}] Live backend access enabled on port(s): ${BACKEND_PORT}`);
    }

    let stdout = "";
    let stderr = "";

    const proc = spawn("docker", dockerArgs, {
      timeout: TASK_TIMEOUT_MS,
    });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    // ── Signal watcher: rebuild backend when agent requests it ───────────
    let signalWatcherInterval = null;
    if (BACKEND_LIVE_ACCESS && BACKEND_DOCKER_COMPOSE) {
      const signalsDir = stagingPath
        ? join(stagingPath, "signals")
        : join(STAGING_DIR, `signals-${containerName}`);
      const repoPath = stagingPath ? join(stagingPath, "repo") : null;

      signalWatcherInterval = setInterval(async () => {
        const rebuildSignal = join(signalsDir, "rebuild");
        const doneSignal = join(signalsDir, "rebuild-done");

        if (existsSync(rebuildSignal)) {
          log(`[${task.identifier}] Rebuild signal received from agent`);

          try {
            // Remove the request signal
            execSync(`rm -f "${rebuildSignal}"`, { stdio: "pipe" });

            // Rebuild and restart the backend from the agent's modified code
            const composeFile = repoPath
              ? join(repoPath, BACKEND_DOCKER_COMPOSE)
              : null;

            if (composeFile && existsSync(composeFile)) {
              const composeDir = join(composeFile, "..");

              log(`[${task.identifier}] Rebuilding backend...`);
              execSync(
                `docker compose -f "${composeFile}" build ${BACKEND_SERVICE_NAME}`,
                { cwd: composeDir, stdio: "pipe", timeout: 120_000 }
              );

              log(`[${task.identifier}] Restarting backend...`);
              execSync(
                `docker compose -f "${composeFile}" up -d ${BACKEND_SERVICE_NAME}`,
                { cwd: composeDir, stdio: "pipe", timeout: 60_000 }
              );

              // Wait for health check if configured
              if (BACKEND_HEALTH_URL) {
                const healthy = await waitForHealth(
                  BACKEND_HEALTH_URL,
                  BACKEND_HEALTH_TIMEOUT_MS
                );
                if (!healthy) {
                  log(`[${task.identifier}] Backend health check failed after rebuild`);
                }
              }

              log(`[${task.identifier}] Backend rebuilt and ready`);
            } else {
              log(`[${task.identifier}] Compose file not found for rebuild`);
            }
          } catch (err) {
            log(`[${task.identifier}] Rebuild error: ${err.message}`);
          }

          // Signal done (agent is waiting for this file)
          writeFileSync(doneSignal, new Date().toISOString());
        }
      }, SIGNAL_POLL_MS);
    }

    proc.on("close", (code) => {
      // Stop signal watcher
      if (signalWatcherInterval) clearInterval(signalWatcherInterval);

      log(`[${task.identifier}] Container exited with code ${code}`);

      let result = null;
      try {
        result = JSON.parse(stdout);
      } catch {
        // stdout might not be valid JSON
      }

      resolve({
        exitCode: code,
        result,
        stdout,
        stderr,
        containerName,
        stagingPath,
      });
    });

    proc.on("error", (err) => {
      if (signalWatcherInterval) clearInterval(signalWatcherInterval);
      log(`[${task.identifier}] Container error: ${err.message}`);
      reject(err);
    });
  });
}

// ─── Backend Docker Testing (orchestrator-mediated) ─────────────────────────
//
// The sandboxed agent can't run Docker (no socket access). Instead:
//   1. Agent makes code changes and commits to the staging copy
//   2. Orchestrator extracts the changes from the staging copy
//   3. Orchestrator rebuilds the backend container on the HOST
//   4. Orchestrator runs tests against the backend container
//   5. If tests fail, orchestrator feeds results back to a NEW agent session
//   6. Repeat up to MAX_FIX_ITERATIONS
//
// This keeps the sandbox secure while still allowing integration testing.

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function runBackendTests(repoPath) {
  const composeFile = join(repoPath, BACKEND_DOCKER_COMPOSE);
  const composeDir = join(repoPath, BACKEND_DOCKER_COMPOSE.replace(/\/[^/]+$/, ""));

  if (!existsSync(composeFile)) {
    return { success: false, output: `docker-compose file not found: ${composeFile}` };
  }

  let output = "";
  let success = false;

  try {
    // Build the backend from the modified code
    log(`[backend-test] Building backend from ${composeDir}...`);
    execSync(`docker compose -f "${composeFile}" build ${BACKEND_SERVICE_NAME}`, {
      cwd: composeDir,
      stdio: "pipe",
      timeout: 120_000,
    });

    // Start the backend
    log(`[backend-test] Starting backend...`);
    execSync(`docker compose -f "${composeFile}" up -d ${BACKEND_SERVICE_NAME}`, {
      cwd: composeDir,
      stdio: "pipe",
      timeout: 60_000,
    });

    // Wait for health check if configured
    if (BACKEND_HEALTH_URL) {
      log(`[backend-test] Waiting for health: ${BACKEND_HEALTH_URL}`);
      const healthy = await waitForHealth(BACKEND_HEALTH_URL, BACKEND_HEALTH_TIMEOUT_MS);
      if (!healthy) {
        output = `Backend failed health check after ${BACKEND_HEALTH_TIMEOUT_MS}ms at ${BACKEND_HEALTH_URL}`;
        return { success: false, output };
      }
    }

    // Run tests
    log(`[backend-test] Running tests: ${BACKEND_TEST_CMD}`);
    output = execSync(BACKEND_TEST_CMD, {
      cwd: composeDir,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300_000, // 5 min for tests
    });
    success = true;
    log(`[backend-test] Tests passed`);

  } catch (err) {
    output = err.stdout?.toString() || "";
    output += "\n" + (err.stderr?.toString() || err.message);
    log(`[backend-test] Tests failed`);
  } finally {
    // Always tear down
    try {
      execSync(`docker compose -f "${composeFile}" down --remove-orphans`, {
        cwd: composeDir,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      // best-effort cleanup
    }
  }

  return { success, output };
}

function cleanupStaging(stagingPath) {
  if (stagingPath && existsSync(stagingPath)) {
    try {
      execSync(`rm -rf "${stagingPath}"`, { stdio: "pipe" });
    } catch {
      log(`Warning: could not clean up staging dir: ${stagingPath}`);
    }
  }
}

// ─── Process a single task ──────────────────────────────────────────────────
async function processTask(task) {
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`Processing: ${task.identifier} — ${task.title}`);

  await updateIssueStatus(task.id, "In Progress");
  await addIssueComment(task.id, `🤖 Automated task runner is working on this.\n\nModel: ${CLAUDE_MODEL}\nMax turns: ${MAX_TURNS}${BACKEND_DOCKER_COMPOSE ? `\nBackend testing: enabled (${BACKEND_SERVICE_NAME})` : ""}`);

  let lastStagingPath = null;
  let backendStarted = false;

  try {
    // ── Pre-flight: Start backend in live access mode ──────────────────
    // In live mode, we start the backend BEFORE the agent so it can curl it.
    // The agent's staging copy is created inside runInContainer, so for the
    // initial start we use the LOCAL_REPO_PATH or REPO_URL source directly.
    if (BACKEND_LIVE_ACCESS && BACKEND_DOCKER_COMPOSE && LOCAL_REPO_PATH) {
      const composeFile = join(LOCAL_REPO_PATH, BACKEND_DOCKER_COMPOSE);
      if (existsSync(composeFile)) {
        const composeDir = join(composeFile, "..");
        log(`[${task.identifier}] Starting backend for live access...`);
        try {
          execSync(`docker compose -f "${composeFile}" up -d ${BACKEND_SERVICE_NAME}`, {
            cwd: composeDir, stdio: "pipe", timeout: 60_000,
          });
          backendStarted = true;

          if (BACKEND_HEALTH_URL) {
            log(`[${task.identifier}] Waiting for backend health...`);
            const healthy = await waitForHealth(BACKEND_HEALTH_URL, BACKEND_HEALTH_TIMEOUT_MS);
            if (!healthy) {
              log(`[${task.identifier}] Backend health check timed out — continuing anyway`);
            }
          }
          log(`[${task.identifier}] Backend is running`);
        } catch (err) {
          log(`[${task.identifier}] Failed to start backend: ${err.message}`);
        }
      }
    }

    // ── Phase 1: Agent makes code changes ──────────────────────────────
    let outcome = await runInContainer(task);
    lastStagingPath = outcome.stagingPath;

    if (outcome.exitCode !== 0) {
      log(`[${task.identifier}] Failed with exit code ${outcome.exitCode}`);
      await addIssueComment(task.id,
        `❌ Automated implementation failed (exit code ${outcome.exitCode}).\n\n**Error output:**\n\`\`\`\n${outcome.stderr.slice(-1500)}\n\`\`\`\n\nThis task needs manual attention.`
      );
      await updateIssueStatus(task.id, "Todo");
      return;
    }

    // ── Phase 2: Backend Docker testing (if configured) ────────────────
    // The orchestrator builds and tests the backend on the HOST, then
    // feeds results back to the agent if tests fail.
    if (BACKEND_DOCKER_COMPOSE && outcome.stagingPath) {
      const repoPath = join(outcome.stagingPath, "repo");

      for (let iteration = 1; iteration <= MAX_FIX_ITERATIONS; iteration++) {
        log(`[${task.identifier}] Backend test iteration ${iteration}/${MAX_FIX_ITERATIONS}`);
        await addIssueComment(task.id,
          `🔧 Running backend integration tests (iteration ${iteration}/${MAX_FIX_ITERATIONS})...`
        );

        const testResult = await runBackendTests(repoPath);

        if (testResult.success) {
          log(`[${task.identifier}] Backend tests passed on iteration ${iteration}`);
          await addIssueComment(task.id, `✅ Backend integration tests passed.`);
          break;
        }

        log(`[${task.identifier}] Backend tests failed on iteration ${iteration}`);

        if (iteration >= MAX_FIX_ITERATIONS) {
          await addIssueComment(task.id,
            `⚠️ Backend tests still failing after ${MAX_FIX_ITERATIONS} iterations.\n\n**Last test output:**\n\`\`\`\n${testResult.output.slice(-2000)}\n\`\`\`\n\nPushing current state for manual review.`
          );
          break;
        }

        // Feed test failures back to a new agent session
        const fixPrompt = `
The orchestrator ran the backend Docker container and the integration tests FAILED.
You need to fix the code so the tests pass.

Test output:
\`\`\`
${testResult.output.slice(-3000)}
\`\`\`

This is iteration ${iteration} of ${MAX_FIX_ITERATIONS}. Fix the issues, commit, and push.
Do NOT try to run docker or docker compose — you don't have Docker access.
The orchestrator will re-run the backend tests after you commit.`;

        // Re-run agent with the same staging copy (preserves prior changes)
        const fixOutcome = await runInContainer(task, fixPrompt);

        if (fixOutcome.exitCode !== 0) {
          log(`[${task.identifier}] Fix iteration ${iteration} agent failed`);
          await addIssueComment(task.id,
            `❌ Fix iteration ${iteration} failed (exit code ${fixOutcome.exitCode}). Pushing current state.`
          );
          break;
        }
      }
    }

    // ── Phase 3: Check for MR ──────────────────────────────────────────
    const mr = await checkForMR(task.identifier);

    if (mr) {
      log(`[${task.identifier}] MR created: ${mr.web_url}`);

      await addIssueComment(task.id,
        `✅ Automated implementation complete.\n\n**MR:** ${mr.web_url}\n**Title:** ${mr.title}\n\nPlease review and merge.`
      );
      await updateIssueStatus(task.id, "In Review");

    } else if (outcome.exitCode === 0) {
      log(`[${task.identifier}] Completed but no MR created.`);

      const summary = outcome.result?.result || "No details available.";
      await addIssueComment(task.id,
        `⚠️ Task runner completed but could not open an MR.\n\n**Summary:**\n${summary.slice(0, 2000)}\n\nThis may need manual implementation.`
      );
      await updateIssueStatus(task.id, "Todo");

    } else {
      await updateIssueStatus(task.id, "Todo");
    }
  } catch (err) {
    log(`[${task.identifier}] Error: ${err.message}`);

    await addIssueComment(task.id,
      `❌ Task runner encountered an error: ${err.message}\n\nThis task needs manual attention.`
    );
    await updateIssueStatus(task.id, "Todo");
  } finally {
    // Tear down backend if we started it
    if (backendStarted && BACKEND_DOCKER_COMPOSE && LOCAL_REPO_PATH) {
      const composeFile = join(LOCAL_REPO_PATH, BACKEND_DOCKER_COMPOSE);
      try {
        log(`[${task.identifier}] Tearing down backend...`);
        execSync(`docker compose -f "${composeFile}" down --remove-orphans`, {
          cwd: join(composeFile, ".."), stdio: "pipe", timeout: 30_000,
        });
      } catch {
        // best-effort cleanup
      }
    }

    // Clean up staging directory
    cleanupStaging(lastStagingPath);
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString().slice(0, 19)}] ${msg}`);
}

async function main() {
  log("Linear Task Runner started (GitLab edition)");
  log(`Linear auth: ${LINEAR_AUTH_MODE === "api-key" ? "API key" : "OAuth (auto-refreshing)"}`);
  log(`Polling every ${POLL_INTERVAL_MS / 1000}s for issues with label="${LINEAR_LABEL}" status="${LINEAR_STATUS}"`);
  log(`Model: ${CLAUDE_MODEL} | Max turns: ${MAX_TURNS} | Timeout: ${TASK_TIMEOUT_MS / 1000}s`);
  log(`Repo: ${LOCAL_REPO_PATH ? `LOCAL ${LOCAL_REPO_PATH}` : REPO_URL}`);
  log(`GitLab: ${GITLAB_URL} | Project: ${GITLAB_PROJECT_ID}`);
  if (BACKEND_DOCKER_COMPOSE) {
    log(`Backend testing: ${BACKEND_DOCKER_COMPOSE} (service: ${BACKEND_SERVICE_NAME})`);
    if (BACKEND_LIVE_ACCESS) {
      log(`  Mode: LIVE ACCESS — agent can curl backend on port(s) ${BACKEND_PORT}`);
      log(`  Signal-based rebuild enabled`);
    } else {
      log(`  Mode: orchestrator-mediated (agent has no backend access)`);
    }
    log(`  Test cmd: ${BACKEND_TEST_CMD}`);
    log(`  Max fix iterations: ${MAX_FIX_ITERATIONS}`);
    if (BACKEND_HEALTH_URL) log(`  Health URL: ${BACKEND_HEALTH_URL}`);
  }

  // Build the Docker image first
  log("Building Docker image...");
  try {
    execSync(`docker build -t ${DOCKER_IMAGE} .`, { stdio: "inherit" });
    log("Docker image built successfully.");
  } catch (err) {
    log(`Failed to build Docker image: ${err.message}`);
    process.exit(1);
  }

  // Poll loop
  while (true) {
    try {
      const tasks = await fetchPendingTasks();

      if (tasks.length > 0) {
        log(`Found ${tasks.length} pending task(s)`);

        for (const task of tasks) {
          await processTask(task);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    } catch (err) {
      log(`Error in poll cycle: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
