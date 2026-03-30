#!/usr/bin/env node
// =============================================================================
// Linear Task Runner — Orchestrator (GitHub + GitLab Edition)
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
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnv } from "./lib/env.mjs";
import { resolveAgentAuth } from "./lib/auth.mjs";
import { buildSkillsPromptSection } from "./lib/skills.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

loadEnv(__dirname);

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

// Agent provider: "claude" (default) or "codex" (OpenAI)
const AGENT = resolveAgentAuth(log);
const AGENT_PROVIDER = AGENT.provider;
const AGENT_API_KEY = AGENT.apiKey;
const CODEX_MODEL = process.env.CODEX_MODEL || "o3";
const CODEX_AUTH_JSON = AGENT.codexAuthJson;
const GIT_PROVIDER = process.env.GIT_PROVIDER || "gitlab";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const REPO_URL = process.env.REPO_URL;

// Local repo support: bind-mount a pre-configured local repo instead of cloning
// Set LOCAL_REPO_PATH to the absolute path of your local checkout
const LOCAL_REPO_PATH = process.env.LOCAL_REPO_PATH || "";

const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "claude-task-runner";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000");
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "50");
const TASK_TIMEOUT_MS = parseInt(process.env.TASK_TIMEOUT_MS || "1800000"); // 30 min
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";

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
const MAX_CONTEXT_RESETS = parseInt(process.env.MAX_CONTEXT_RESETS || "5");

// Live backend access: the agent can curl the backend directly.
// The orchestrator starts the backend before the agent, and watches for
// rebuild signals from the agent during execution.
const BACKEND_LIVE_ACCESS = process.env.BACKEND_LIVE_ACCESS === "true";
const BACKEND_PORT = process.env.BACKEND_PORT || "3000";
const SIGNAL_POLL_MS = 2000; // how often to check for rebuild signals

// Review feedback loop: after the MR/PR is created, poll for review comments
// and spawn revision sessions to address them.
const REVIEW_POLL_INTERVAL_MS = parseInt(process.env.REVIEW_POLL_INTERVAL_MS || "30000"); // 30s
const MAX_REVIEW_ROUNDS = parseInt(process.env.MAX_REVIEW_ROUNDS || "5");
const REVIEW_WAIT_TIMEOUT_MS = parseInt(process.env.REVIEW_WAIT_TIMEOUT_MS || "3600000"); // 1 hour

// Concurrency: how many tasks to work on simultaneously
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || "3");

// Skills: path to a directory of Claude Code skill markdown files.
// All skills are mounted into the container and Claude is informed which are
// relevant to the task at hand.
const CLAUDE_SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR || "";

// Staging directory for extracting agent changes before backend testing
const STAGING_DIR = process.env.STAGING_DIR || "/tmp/task-staging";

// File-based task tracking — survives orchestrator restarts
const TASK_STATE_FILE = join(__dirname, ".task-state.json");

function loadTaskState() {
  if (!existsSync(TASK_STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TASK_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveTaskState(state) {
  writeFileSync(TASK_STATE_FILE, JSON.stringify(state, null, 2));
}

function markTaskActive(identifier, containerName) {
  const state = loadTaskState();
  state[identifier] = { status: "active", startedAt: new Date().toISOString(), containerName };
  saveTaskState(state);
}

function markTaskDone(identifier, result) {
  const state = loadTaskState();
  state[identifier] = { status: "done", result, finishedAt: new Date().toISOString() };
  saveTaskState(state);
}

function isTaskAlreadyHandled(identifier) {
  const state = loadTaskState();
  const entry = state[identifier];
  if (!entry) return false;

  if (entry.status === "active") {
    // Check if it's been active for too long (stale from a crash) — 2 hours
    const staleMs = 2 * 60 * 60 * 1000;
    if (Date.now() - new Date(entry.startedAt).getTime() > staleMs) {
      log(`[${identifier}] Stale active state (started ${entry.startedAt}) — re-processing`);
      return false;
    }
    return true;
  }

  if (entry.status === "done") return true;

  return false;
}

// Linear filter — LINEAR_STATUS supports comma-separated values (e.g. "Backlog,In Progress")
const LINEAR_LABEL = process.env.LINEAR_LABEL || "autofix";
const LINEAR_STATUS_RAW = process.env.LINEAR_STATUS || "Todo";
const LINEAR_STATUSES = LINEAR_STATUS_RAW.split(",").map((s) => s.trim()).filter(Boolean);

// Agent auth already validated by resolveAgentAuth()
if (GIT_PROVIDER === "github" && (!GITHUB_TOKEN || !GITHUB_REPO)) {
  console.error("Missing required env vars for GitHub: GITHUB_TOKEN, GITHUB_REPO");
  process.exit(1);
}
if (GIT_PROVIDER === "gitlab" && (!GITLAB_TOKEN || !GITLAB_PROJECT_ID)) {
  console.error("Missing required env vars for GitLab: GITLAB_TOKEN, GITLAB_PROJECT_ID");
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
    query PendingTasks($labelName: String!, $statusNames: [String!]!) {
      issues(
        filter: {
          labels: { name: { eq: $labelName } }
          state: { name: { in: $statusNames } }
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
          state { name }
          comments {
            nodes {
              body
              user { name }
              createdAt
            }
          }
          attachments {
            nodes {
              title
              url
              sourceType
            }
          }
        }
      }
    }
  `, {
    labelName: LINEAR_LABEL,
    statusNames: LINEAR_STATUSES,
  });

  return data.issues.nodes;
}

// ─── Update Linear issue status ─────────────────────────────────────────────
async function updateIssueStatus(issueId, statusName) {
  // First get the issue's team so we find the right workflow state
  const issueData = await linearQuery(`
    query GetIssueTeam($id: String!) {
      issue(id: $id) {
        team { id }
      }
    }
  `, { id: issueId });

  const teamId = issueData.issue?.team?.id;
  if (!teamId) {
    console.error(`Could not find team for issue: ${issueId}`);
    return;
  }

  // Find the workflow state matching this name for THIS team
  const statesData = await linearQuery(`
    query States($teamId: ID!) {
      workflowStates(filter: { name: { eq: "${statusName}" }, team: { id: { eq: $teamId } } }) {
        nodes { id name }
      }
    }
  `, { teamId });

  const state = statesData.workflowStates.nodes[0];
  if (!state) {
    console.error(`Could not find workflow state "${statusName}" for team ${teamId}`);
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
// Disabled for now — comments pollute the context pulled from the ticket.
// Re-enable by removing the early return.
async function addIssueComment(issueId, body) {
  return;
  /* eslint-disable no-unreachable */
  await linearQuery(`
    mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `, { issueId, body });
}

// ─── Git Provider API helper ────────────────────────────────────────────────
async function gitApi(method, path, body = null) {
  let url;
  let headers;

  if (GIT_PROVIDER === "github") {
    url = `https://api.github.com/repos/${GITHUB_REPO}${path}`;
    headers = {
      "Authorization": `token ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    };
  } else {
    const encodedProject = encodeURIComponent(GITLAB_PROJECT_ID);
    url = `${GITLAB_URL}/api/v4/projects/${encodedProject}${path}`;
    headers = {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    };
  }

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    const providerName = GIT_PROVIDER === "github" ? "GitHub" : "GitLab";
    throw new Error(`${providerName} API ${method} ${path}: ${res.status} ${text}`);
  }

  return JSON.parse(text);
}

// ─── Create an MR/PR via API (fallback when Claude didn't do it) ─────────────
async function createMR(task, branchName) {
  const title = `Draft: ${task.identifier} ${task.title}`;
  const body = `Automated implementation of ${task.identifier}.\n\n${task.url}`;
  try {
    if (GIT_PROVIDER === "github") {
      const pr = await gitApi("POST", "/pulls", {
        head: branchName,
        base: DEFAULT_BRANCH,
        title,
        body,
        draft: true,
      });
      log(`[${task.identifier}] Orchestrator created PR: ${pr.html_url}`);
      return { web_url: pr.html_url, title: pr.title, number: pr.number };
    } else {
      const mr = await gitApi("POST", "/merge_requests", {
        source_branch: branchName,
        target_branch: DEFAULT_BRANCH,
        title,
        description: body,
        draft: true,
      });
      log(`[${task.identifier}] Orchestrator created MR: ${mr.web_url}`);
      return mr;
    }
  } catch (err) {
    log(`[${task.identifier}] Could not auto-create MR: ${err.message}`);
    return null;
  }
}

// ─── Check if an MR/PR exists for this task ─────────────────────────────────
async function checkForMR(taskIdentifier) {
  try {
    if (GIT_PROVIDER === "github") {
      const prs = await gitApi("GET", `/pulls?state=open`);
      const match = prs.find((pr) => pr.title.includes(taskIdentifier));
      if (!match) return null;
      return { web_url: match.html_url, title: match.title, number: match.number };
    } else {
      const mrs = await gitApi("GET",
        `/merge_requests?state=opened&search=${encodeURIComponent(taskIdentifier)}&per_page=1`
      );
      return mrs.length > 0 ? mrs[0] : null;
    }
  } catch {
    return null;
  }
}

// ─── Fetch review comments on an MR/PR ──────────────────────────────────────
// Returns new comments since lastCheckedAt (ISO string or null for all).
// Filters out bot comments to avoid self-loops.
async function fetchReviewComments(mrId, lastCheckedAt) {
  const comments = [];

  try {
    if (GIT_PROVIDER === "github") {
      // GitHub: fetch both review comments and issue comments
      const [reviewComments, issueComments] = await Promise.all([
        gitApi("GET", `/pulls/${mrId}/comments?sort=created&direction=desc&per_page=50`),
        gitApi("GET", `/issues/${mrId}/comments?sort=created&direction=desc&per_page=50`),
      ]);

      for (const c of [...reviewComments, ...issueComments]) {
        if (lastCheckedAt && new Date(c.created_at) <= new Date(lastCheckedAt)) continue;
        // Skip bot/automation comments that shouldn't trigger revision rounds.
        // Intentionally allow coderabbit-ai (useful review feedback).
        const login = c.user?.login?.toLowerCase() || "";
        const isBot = login === "github-actions[bot]"
          || login.endsWith("[bot]")
          || login.includes("claude");
        if (isBot) continue;
        comments.push({
          author: c.user?.login || "unknown",
          body: c.body,
          created_at: c.created_at,
          path: c.path || null, // file path for review comments
        });
      }
    } else {
      // GitLab: fetch discussions (threads)
      const iid = mrId.iid || mrId;
      const discussions = await gitApi("GET", `/merge_requests/${iid}/discussions`);

      for (const disc of discussions) {
        for (const note of disc.notes) {
          if (note.system) continue;
          if (lastCheckedAt && new Date(note.created_at) <= new Date(lastCheckedAt)) continue;
          // Skip bot/automation comments that shouldn't trigger revision rounds.
          // Intentionally allow coderabbitai (useful review feedback).
          const username = note.author?.username?.toLowerCase() || "";
          const isBot = username.includes("claude")
            || username.endsWith("_bot")
            || username === "ghost";
          if (isBot) continue;
          // Skip resolved threads
          if (note.resolvable && note.resolved) continue;
          comments.push({
            author: note.author?.username || "unknown",
            body: note.body,
            created_at: note.created_at,
            path: note.position?.new_path || null,
          });
        }
      }
    }
  } catch (err) {
    log(`[review] Error fetching comments: ${err.message}`);
  }

  // Sort oldest first
  comments.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return comments;
}

// ─── Check if MR/PR is approved or merged ───────────────────────────────────
async function checkMRStatus(mrId) {
  try {
    if (GIT_PROVIDER === "github") {
      const pr = await gitApi("GET", `/pulls/${mrId}`);
      if (pr.merged) return "merged";
      if (pr.state === "closed") return "closed";

      // Check for approvals
      const reviews = await gitApi("GET", `/pulls/${mrId}/reviews`);
      const approved = reviews.some((r) => r.state === "APPROVED");
      if (approved) return "approved";

      return "open";
    } else {
      const iid = mrId.iid || mrId;
      const mr = await gitApi("GET", `/merge_requests/${iid}`);
      if (mr.state === "merged") return "merged";
      if (mr.state === "closed") return "closed";

      // Check for approvals
      try {
        const approvals = await gitApi("GET", `/merge_requests/${iid}/approvals`);
        if (approvals.approved) return "approved";
      } catch {
        // Approvals API may not be available on all tiers
      }

      return "open";
    }
  } catch (err) {
    log(`[review] Error checking MR status: ${err.message}`);
    return "unknown";
  }
}

// ─── Review feedback loop ───────────────────────────────────────────────────
// After MR/PR is created, poll for comments. When new comments arrive,
// spawn a revision container to address them. Repeat until approved,
// merged, max rounds hit, or timeout.
async function reviewFeedbackLoop(task, mr, stagingPath) {
  const mrId = GIT_PROVIDER === "github" ? mr.number : (mr.iid || mr.number);
  const branchName = `task/${task.identifier.toLowerCase()}`;
  let lastCheckedAt = new Date().toISOString();
  let round = 0;
  const startTime = Date.now();

  log(`[${task.identifier}] Entering review feedback loop (max ${MAX_REVIEW_ROUNDS} rounds, timeout ${REVIEW_WAIT_TIMEOUT_MS / 1000}s)`);
  log(`[${task.identifier}] Polling for review comments every ${REVIEW_POLL_INTERVAL_MS / 1000}s...`);

  while (round < MAX_REVIEW_ROUNDS) {
    // Check timeout
    if (Date.now() - startTime > REVIEW_WAIT_TIMEOUT_MS) {
      log(`[${task.identifier}] Review loop timeout reached (${REVIEW_WAIT_TIMEOUT_MS / 1000}s) — exiting`);
      break;
    }

    // Wait before polling
    await new Promise((r) => setTimeout(r, REVIEW_POLL_INTERVAL_MS));

    // Check if MR was approved or merged
    const status = await checkMRStatus(mrId);
    if (status === "approved") {
      log(`[${task.identifier}] MR/PR approved! Review loop complete.`);
      await updateIssueStatus(task.id, "Done");
      return "approved";
    }
    if (status === "merged") {
      log(`[${task.identifier}] MR/PR merged! Review loop complete.`);
      await updateIssueStatus(task.id, "Done");
      return "merged";
    }
    if (status === "closed") {
      log(`[${task.identifier}] MR/PR was closed. Stopping review loop.`);
      return "closed";
    }

    // Check for new comments
    const newComments = await fetchReviewComments(mrId, lastCheckedAt);
    if (newComments.length === 0) continue;

    round++;
    log(`[${task.identifier}] Review round ${round}/${MAX_REVIEW_ROUNDS}: ${newComments.length} new comment(s)`);
    for (const c of newComments) {
      log(`[${task.identifier}]   @${c.author}: ${c.body.slice(0, 150)}${c.body.length > 150 ? "..." : ""}`);
    }

    // Update lastCheckedAt to the newest comment
    lastCheckedAt = newComments[newComments.length - 1].created_at;

    // Build a revision prompt from the comments
    const commentSummary = newComments
      .map((c) => `@${c.author}${c.path ? ` (on ${c.path})` : ""}: ${c.body}`)
      .join("\n\n---\n\n");

    const revisionPrompt = `
You are addressing review feedback on an open ${GIT_PROVIDER === "github" ? "pull request" : "merge request"}.

Review comments to address (round ${round}/${MAX_REVIEW_ROUNDS}):
${commentSummary}

Instructions:
1. You are already on branch "${branchName}" — do NOT create a new branch
2. Read and understand each review comment
3. Make the requested changes
4. After each fix, commit and push immediately:
   git add -A && git commit -m "${task.identifier}: address review feedback (round ${round})" && git push origin ${branchName}
5. Only address what reviewers asked for — do not make unrelated changes
6. If a comment is just approval/praise with no action needed, skip it
7. Use ${GIT_PROVIDER === "github" ? "gh" : "glab"} CLI for any ${GIT_PROVIDER === "github" ? "GitHub" : "GitLab"} operations — do NOT make direct API calls
8. Use targeted file reads (specific line ranges + grep) to conserve context. Delegate
   independent changes to sub-agents via the Task tool — tell them the branch is "${branchName}"`;

    // Spawn a revision container
    const revisionOutcome = await runInContainer(task, revisionPrompt);

    if (revisionOutcome.exitCode !== 0) {
      log(`[${task.identifier}] Revision round ${round} failed (exit code ${revisionOutcome.exitCode})`);
      rescueUnpushedWork(revisionOutcome.stagingPath, task.identifier);
      break;
    }

    log(`[${task.identifier}] Revision round ${round} complete — waiting for next review`);
  }

  if (round >= MAX_REVIEW_ROUNDS) {
    log(`[${task.identifier}] Max review rounds (${MAX_REVIEW_ROUNDS}) reached — exiting loop`);
  }

  return "max_rounds";
}

// ─── Prepare a staging copy of the local repo ───────────────────────────────
// Creates a clean copy of the local repo for the container to work on.
// This avoids modifying your working tree directly.
function prepareStagingCopy(taskIdentifier) {
  const stagingPath = join(STAGING_DIR, `task-${taskIdentifier}-${randomUUID().slice(0, 8)}`);
  mkdirSync(stagingPath, { recursive: true });

  const copyStart = Date.now();
  log(`[${taskIdentifier}] Copying local repo to staging: ${stagingPath}`);

  // cp -r (not -a) so ownership isn't preserved, then chmod/chown everything
  // so the container's claude-runner user (UID 1000) can access all files
  execSync(`cp -r "${LOCAL_REPO_PATH}" "${stagingPath}/repo"`, { stdio: "pipe" });
  execSync(`chmod -R 777 "${stagingPath}/repo"`, { stdio: "pipe" });
  log(`[${taskIdentifier}] Copy took ${((Date.now() - copyStart) / 1000).toFixed(1)}s`);

  // Ensure the remote points to the actual remote, not the local path
  if (REPO_URL) {
    execSync(`git -C "${stagingPath}/repo" remote set-url origin "${REPO_URL}"`, { stdio: "pipe" });
  }

  // Always start from the latest main/master regardless of what branch was checked out locally
  const repoDir = `${stagingPath}/repo`;
  try {
    // Clean everything first — local changes from the copied repo would block checkout
    execSync(`git -C "${repoDir}" reset --hard HEAD`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" clean -fd`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" fetch origin`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" checkout ${DEFAULT_BRANCH}`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" reset --hard origin/${DEFAULT_BRANCH}`, { stdio: "pipe" });
    execSync(`git -C "${repoDir}" clean -fd`, { stdio: "pipe" });
    log(`[${taskIdentifier}] Staging repo reset to latest ${DEFAULT_BRANCH}`);
  } catch (err) {
    log(`[${taskIdentifier}] Warning: could not reset to main: ${err.message}`);
  }

  return stagingPath;
}

// ─── Download images from Linear comments/attachments ───────────────────────
// Linear stores images as markdown ![alt](url) in comment bodies.
// We download them to the staging dir so the agent can view them.
async function downloadTaskImages(task, destDir) {
  mkdirSync(destDir, { recursive: true });
  const downloaded = [];

  // Extract image URLs from markdown in description and comments
  const allText = [
    task.description || "",
    ...(task.comments?.nodes?.map((c) => c.body) || []),
  ].join("\n");

  const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  let idx = 0;
  while ((match = imgRegex.exec(allText)) !== null) {
    const [, alt, url] = match;
    if (!url.startsWith("http")) continue;
    idx++;
    const ext = url.match(/\.(png|jpg|jpeg|gif|webp|svg)/i)?.[1] || "png";
    const filename = `image-${idx}.${ext}`;
    const filepath = join(destDir, filename);
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        writeFileSync(filepath, buffer);
        downloaded.push({ filename, alt: alt || `image-${idx}`, url });
        log(`[${task.identifier}] Downloaded image: ${filename} (${alt || url.slice(0, 60)})`);
      }
    } catch (err) {
      log(`[${task.identifier}] Failed to download image ${url.slice(0, 60)}: ${err.message}`);
    }
  }

  // Also grab attachments from the task
  for (const att of task.attachments?.nodes || []) {
    if (!att.url?.startsWith("http")) continue;
    idx++;
    const ext = att.url.match(/\.(png|jpg|jpeg|gif|webp|svg|pdf)/i)?.[1] || "png";
    const filename = `attachment-${idx}.${ext}`;
    const filepath = join(destDir, filename);
    try {
      const res = await fetch(att.url);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        writeFileSync(filepath, buffer);
        downloaded.push({ filename, alt: att.title || `attachment-${idx}`, url: att.url });
        log(`[${task.identifier}] Downloaded attachment: ${filename} (${att.title || "untitled"})`);
      }
    } catch (err) {
      log(`[${task.identifier}] Failed to download attachment: ${err.message}`);
    }
  }

  return downloaded;
}

// ─── Build label-based scope instructions ───────────────────────────────────
function buildScopeInstructions(task) {
  const labels = (task.labels?.nodes || []).map((l) => l.name.toLowerCase());

  const hasFrontend = labels.some((l) => l.includes("frontend") || l.includes("front-end") || l.includes("ui") || l.includes("client"));
  const hasBackend = labels.some((l) => l.includes("backend") || l.includes("back-end") || l.includes("api") || l.includes("server"));

  if (hasFrontend && !hasBackend) {
    return `
SCOPE — FRONTEND ONLY:
This task is labeled as frontend work. Focus exclusively on the frontend/client side:
- Only modify frontend code (components, pages, styles, client-side logic)
- If the feature requires backend changes (new API endpoints, data models, etc.),
  create stub/placeholder implementations with TODO comments explaining what the
  backend needs to provide (expected request/response shapes, endpoint paths, etc.)
- Do NOT modify backend/server code beyond adding stubs
- Make the frontend work with mock data or stub responses where needed`;
  }

  if (hasBackend && !hasFrontend) {
    return `
SCOPE — BACKEND ONLY:
This task is labeled as backend work. Focus exclusively on the backend/server side:
- Only modify backend code (API endpoints, services, data models, middleware)
- If the feature requires frontend changes (new UI, forms, displays, etc.),
  create stub/placeholder components or document what the frontend needs in
  TODO comments (expected props, API response shapes, endpoint paths, etc.)
- Do NOT modify frontend/client code beyond adding stubs
- Ensure API contracts are well-documented for the frontend team`;
  }

  // Both labels or neither — no scope restriction
  return "";
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
async function runInContainer(task, extraPrompt = "") {
  const containerName = `task-${task.identifier}-${randomUUID().slice(0, 8)}`;
  const branchName = `task/${task.identifier.toLowerCase()}`;
  let stagingPath = null;
  // Record container name in task state so send.mjs can reach it
  markTaskActive(task.identifier, containerName);

  // Persistent signals dir for this task — survives context resets.
  // Lives in .orchestra/ (gitignored) so spec + checkpoint files persist
  // across container respawns without polluting the repo.
  const taskSignalsDir = join(
    __dirname, "..", ".orchestra", "tasks",
    task.identifier.toLowerCase().replace(/[^a-z0-9-]/g, "-"), "signals"
  );
  mkdirSync(taskSignalsDir, { recursive: true });
  try { execSync(`chmod -R 777 "${taskSignalsDir}"`, { stdio: "pipe" }); } catch {}

  // Prepare staging copy early so we can download images into it
  if (LOCAL_REPO_PATH) {
    stagingPath = prepareStagingCopy(task.identifier);
  }

  // Download images from the task's description, comments, and attachments
  let imagePromptSection = "";
  const imagesDir = stagingPath
    ? join(stagingPath, "images")
    : join(STAGING_DIR, `images-${containerName}`);
  const downloadedImages = await downloadTaskImages(task, imagesDir);
  if (downloadedImages.length > 0) {
    imagePromptSection = `
REFERENCE IMAGES:
The following images were attached to this task. Review them for context (mockups, screenshots, diagrams).
They are located at /workspace/images/ inside the container:
${downloadedImages.map((img) => `- /workspace/images/${img.filename} — ${img.alt}`).join("\n")}
Use the Read tool to view these image files before implementing.`;
  }

  return new Promise((resolve, reject) => {
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

    const cliName = GIT_PROVIDER === "github" ? "gh" : "glab";
    const mrTerm = GIT_PROVIDER === "github" ? "pull request" : "merge request";
    const draftTitle = GIT_PROVIDER === "github"
      ? `${task.identifier}: ${task.title}`
      : `Draft: ${task.identifier}: ${task.title}`;
    const cliExample = GIT_PROVIDER === "github"
      ? `gh pr create --draft --title "${draftTitle}" --body "..." --head "${branchName}" --base main`
      : `glab mr create --draft --title "${draftTitle}" --description "..." --source-branch "${branchName}" --target-branch main`;

    const scopeInstructions = buildScopeInstructions(task);
    const labelsList = (task.labels?.nodes || []).map((l) => l.name).join(", ");

    const prompt = `You are an autonomous developer working on a task from the project tracker.

Task: ${task.title}
Task ID: ${task.identifier}
Priority: ${task.priority || "none"}
Labels: ${labelsList || "none"}
${task.project ? `Project: ${task.project.name}` : ""}

Description:
${task.description || "No description provided."}
${task.comments?.nodes?.length ? `

════════════════════════════════════════════════════════════
TEAM COMMENTS — READ THESE CAREFULLY. These contain critical implementation
instructions, context, and requirements from the team. Follow them precisely.
════════════════════════════════════════════════════════════

${task.comments.nodes.map((c) => `[${c.user?.name || "Unknown"}]:\n${c.body}`).join("\n\n────────────────────────────────────────\n\n")}

════════════════════════════════════════════════════════════
END OF TEAM COMMENTS
════════════════════════════════════════════════════════════` : ""}
${extraPrompt ? `\nAdditional context:\n${extraPrompt}` : ""}
${scopeInstructions}
${imagePromptSection}
${buildSkillsPromptSection(CLAUDE_SKILLS_DIR, [
    ...(task.labels?.nodes?.map((l) => l.name) || []),
    task.project?.name || "",
    task.title || "",
  ].join(" "), log)}
════════════════════════════════════════════════════════════
CONTEXT & SUB-AGENTS
════════════════════════════════════════════════════════════
You are running in a long-lived container with a finite context window. Manage it carefully:
- Use targeted reads: read specific line ranges, not entire files. Use grep/search first.
- Summarise tool output mentally — do not re-read results you already processed.
- If a task has multiple independent parts (separate files, separate features), delegate
  each part to a sub-agent using the Task tool. Sub-agents get a fresh context window
  and run concurrently. Always tell them: the working branch is "${branchName}", and they
  should commit and push their changes when done.
- Use sub-agents for expensive exploration too: "search the codebase for X and return
  the relevant file paths and line numbers" is a good sub-agent task.

INBOX (human instructions sent mid-task):
- Before each major step, check /workspace/signals/inbox.txt for new instructions:
    [ -s /workspace/signals/inbox.txt ] && cat /workspace/signals/inbox.txt && truncate -s 0 /workspace/signals/inbox.txt
- If the file has content, read it, acknowledge it in your next response, and incorporate
  the instructions into your current work before continuing.

SPEC FILE & CONTEXT COMPACTION:
Your session has a limit of ${MAX_TURNS} turns. At the very start, BEFORE any other work,
create /workspace/signals/spec.md:

  # Task: ${task.identifier} - ${task.title}
  ## Objective
  <one-sentence summary of what needs to be done>
  ## Steps
  - [ ] Step 1: ...
  - [ ] Step 2: ...
  ## Progress Notes
  <leave blank initially>

After completing each step: check it off ([ ] → [x]) and add a brief Progress Notes entry.

The orchestrator monitors your turn count and context window usage. When you approach
either limit, it will send a CONTEXT WARNING to your inbox. When you receive one:
1. Finish the step you are currently on
2. Check it off in spec.md and note what comes next
3. Commit and push any uncommitted changes
4. Checkpoint: printf 'checkpoint' > /workspace/signals/checkpoint
5. Exit immediately

A fresh session will be spawned that reads your spec and resumes from the first
unchecked step. You can also checkpoint proactively any time you estimate fewer
than ${Math.ceil(MAX_TURNS * 0.2)} turns remain and you still have steps left.
════════════════════════════════════════════════════════════

Instructions:
1. FIRST: Create and switch to branch "${branchName}" immediately:
   git checkout -b ${branchName}
   This must be done BEFORE any other work so nothing is lost.
2. Read the codebase to understand the relevant code — use targeted reads and grep,
   not full-file reads
3. Implement the requested changes following this save pattern:
   - After every meaningful change (new function, fixed bug, added test, etc.), commit AND push:
     git add -A && git commit -m "${task.identifier}: [what you just did]" && git push -u origin ${branchName}
   - Do NOT batch up changes — commit and push after each logical step
   - This ensures no work is lost if the session ends unexpectedly
4. Write or update tests if appropriate
5. Run the existing test suite to verify nothing is broken
6. After all changes are committed and pushed, create a draft ${mrTerm} using ${cliName} CLI with a clear description linking back to ${task.identifier}
7. If you cannot complete the task, still commit and push whatever progress you've made with a WIP commit
${backendPromptSection}

Commit message format: ${task.identifier}: [short description]
${mrTerm.charAt(0).toUpperCase() + mrTerm.slice(1)} title format: ${draftTitle}

Use ${cliName} CLI to create the ${mrTerm}. Link it to the task by including "${task.url}" in the ${mrTerm} body.
Example: ${cliExample}

IMPORTANT: For all ${GIT_PROVIDER === "github" ? "GitHub" : "GitLab"} operations (reading MRs/PRs, creating branches, etc.) use the ${cliName} CLI — do NOT make direct API calls. The CLI is already authenticated via the token in the environment.${GIT_PROVIDER === "gitlab" ? `
To read an existing MR: glab mr view <iid>
To list MRs: glab mr list` : `
To read an existing PR: gh pr view <number>
To list PRs: gh pr list`}`;

    const dockerArgs = [
      "run",
      "--rm",
      "--name", containerName,
      "--cap-add=NET_ADMIN",
      "-e", `AGENT_PROVIDER=${AGENT_PROVIDER}`,
      ...(AGENT_PROVIDER === "codex"
        ? ["-e", `OPENAI_API_KEY=${AGENT_API_KEY}`]
        : ["-e", `ANTHROPIC_API_KEY=${AGENT_API_KEY}`]),
      "-e", `GIT_PROVIDER=${GIT_PROVIDER}`,
      ...(process.env.GIT_USER_NAME ? ["-e", `GIT_USER_NAME=${process.env.GIT_USER_NAME}`] : []),
      ...(process.env.GIT_USER_EMAIL ? ["-e", `GIT_USER_EMAIL=${process.env.GIT_USER_EMAIL}`] : []),
      ...(process.env.CUSTOM_CA_CERT ? ["-e", `CUSTOM_CA_CERT=${process.env.CUSTOM_CA_CERT}`] : []),
      "--memory=4g",
      "--cpus=2",
    ];

    // Provider-specific env vars for the container
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

    // Decide how the repo gets into the container
    if (LOCAL_REPO_PATH) {
      // stagingPath already created above (before image download)
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

    // Mount images directory if we downloaded any
    if (downloadedImages.length > 0) {
      dockerArgs.push("-v", `${imagesDir}:/workspace/images:ro`);
    }

    // Mount skills directory so Claude can invoke skills as /skill-name commands
    if (CLAUDE_SKILLS_DIR && existsSync(CLAUDE_SKILLS_DIR)) {
      dockerArgs.push("-v", `${CLAUDE_SKILLS_DIR}:/home/claude-runner/.claude/commands:ro`);
    }

    // For Codex OAuth: mount auth.json so codex exec can authenticate
    if (AGENT_PROVIDER === "codex" && CODEX_AUTH_JSON) {
      const codexAuthDir = join(STAGING_DIR, `codex-auth-${containerName}`);
      mkdirSync(codexAuthDir, { recursive: true });
      writeFileSync(join(codexAuthDir, "auth.json"), JSON.stringify(CODEX_AUTH_JSON, null, 2));
      execSync(`chmod -R 777 "${codexAuthDir}"`, { stdio: "pipe" });
      dockerArgs.push("-v", `${codexAuthDir}:/home/claude-runner/.codex:rw`);
    }

    // Always mount the persistent signals dir (spec file, checkpoint, inbox, rebuild signals)
    dockerArgs.push("-v", `${taskSignalsDir}:/workspace/signals`);

    // Live backend access: let the agent reach the backend on the host
    if (BACKEND_LIVE_ACCESS) {
      // --add-host ensures host.docker.internal resolves on Linux too
      dockerArgs.push(
        "--add-host=host.docker.internal:host-gateway",
        "-e", `BACKEND_PORT=${BACKEND_PORT}`,
      );
    }

    if (AGENT_PROVIDER === "codex") {
      dockerArgs.push(
        DOCKER_IMAGE,
        "codex", "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model", CODEX_MODEL,
        "--json",
        "--ephemeral",
        prompt,
      );
    } else {
      dockerArgs.push(
        DOCKER_IMAGE,
        "claude", "-p", prompt,
        "--dangerously-skip-permissions",
        "--model", CLAUDE_MODEL,
        "--max-turns", String(MAX_TURNS),
        "--verbose",
        "--output-format", "stream-json",
      );
    }

    const spawnStart = Date.now();
    log(`[${task.identifier}] Spawning container: ${containerName}`);
    log(`[${task.identifier}] Agent: ${AGENT_PROVIDER} (${AGENT.authMode})`);
    if (LOCAL_REPO_PATH) {
      log(`[${task.identifier}] Using local repo: ${LOCAL_REPO_PATH} → staging: ${stagingPath}`);
    }
    if (BACKEND_LIVE_ACCESS) {
      log(`[${task.identifier}] Live backend access enabled on port(s): ${BACKEND_PORT}`);
    }

    let stdout = "";
    let stderr = "";
    let turnCount = 0;
    let contextWarned = false;
    const CONTEXT_WARN_TOKENS = Math.floor(160000 * 0.8); // 80% of 200k context window
    const TURN_WARN_THRESHOLD = Math.floor(MAX_TURNS * 0.8);

    const sendContextWarning = (reason) => {
      if (contextWarned) return;
      contextWarned = true;
      const msg = `CONTEXT WARNING: ${reason}. Finish your current step, update /workspace/signals/spec.md, commit and push, then checkpoint: printf 'checkpoint' > /workspace/signals/checkpoint`;
      try {
        writeFileSync(join(taskSignalsDir, "inbox.txt"), msg + "\n", { flag: "a" });
        log(`[${task.identifier}] Context warning → agent inbox (${reason})`);
      } catch {}
    };

    const proc = spawn("docker", dockerArgs, {
      timeout: TASK_TIMEOUT_MS,
    });

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      // Stream progress to console — each line is a JSON event
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (AGENT_PROVIDER === "codex") {
            if (event.type === "message" && event.message) {
              log(`[${task.identifier}] Codex: ${event.message.slice(0, 200)}`);
            } else if (event.type === "function_call" || event.type === "command") {
              log(`[${task.identifier}] Tool: ${(event.command || event.name || "").slice(0, 150)}`);
            } else if (event.type === "error") {
              log(`[${task.identifier}] Error: ${(event.message || event.error || "").slice(0, 200)}`);
            }
          } else {
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
                  log(`[${task.identifier}] Claude: ${block.text.slice(0, 200)}`);
                } else if (block.type === "tool_use") {
                  log(`[${task.identifier}] Tool: ${block.name}${block.input?.command ? ` → ${block.input.command.slice(0, 100)}` : ""}`);
                }
              }
            } else if (event.type === "result") {
              log(`[${task.identifier}] Result: ${(event.result || "").slice(0, 200)}`);
            }
          }
        } catch {
          // not valid JSON line, ignore
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    // ── Signal watcher: rebuild backend when agent requests it ───────────
    let signalWatcherInterval = null;
    if (BACKEND_LIVE_ACCESS && BACKEND_DOCKER_COMPOSE) {
      const repoPath = stagingPath ? join(stagingPath, "repo") : null;

      signalWatcherInterval = setInterval(async () => {
        const rebuildSignal = join(taskSignalsDir, "rebuild");
        const doneSignal = join(taskSignalsDir, "rebuild-done");

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

      const elapsed = ((Date.now() - spawnStart) / 1000).toFixed(0);
      log(`[${task.identifier}] Container exited with code ${code} after ${elapsed}s`);

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
        signalsDir: taskSignalsDir,
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

// ─── Rescue unpushed work from staging copy ─────────────────────────────────
// If the agent created a branch and committed but didn't push (timeout, error,
// etc.), this saves the work by pushing from the host.
function rescueUnpushedWork(stagingPath, taskIdentifier) {
  if (!stagingPath) return;
  const repoPath = join(stagingPath, "repo");
  if (!existsSync(join(repoPath, ".git"))) return;

  try {
    // Check what branch we're on
    const branch = execSync(`git -C "${repoPath}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf8", stdio: "pipe"
    }).trim();

    log(`[${taskIdentifier}] Staging repo is on branch: ${branch}`);

    // Check if there are uncommitted changes
    const status = execSync(`git -C "${repoPath}" status --porcelain`, {
      encoding: "utf8", stdio: "pipe"
    }).trim();

    if (status) {
      log(`[${taskIdentifier}] Found uncommitted changes — committing as WIP`);
      execSync(`git -C "${repoPath}" add -A`, { stdio: "pipe" });
      execSync(`git -C "${repoPath}" commit -m "${taskIdentifier}: WIP — rescued uncommitted work"`, {
        stdio: "pipe",
        env: { ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_USER_NAME || "claude-task-runner",
          GIT_AUTHOR_EMAIL: process.env.GIT_USER_EMAIL || "claude-task-runner@automated",
          GIT_COMMITTER_NAME: process.env.GIT_USER_NAME || "claude-task-runner",
          GIT_COMMITTER_EMAIL: process.env.GIT_USER_EMAIL || "claude-task-runner@automated" },
      });
    }

    // Check if the branch has commits beyond main/master
    let hasCommits = false;
    for (const base of ["main", "master"]) {
      try {
        const count = execSync(`git -C "${repoPath}" rev-list --count ${base}..${branch}`, {
          encoding: "utf8", stdio: "pipe"
        }).trim();
        if (parseInt(count) > 0) {
          hasCommits = true;
          log(`[${taskIdentifier}] Branch ${branch} has ${count} commit(s) ahead of ${base}`);
        }
        break;
      } catch {
        // base branch doesn't exist, try the other
      }
    }

    if (!hasCommits) {
      log(`[${taskIdentifier}] No commits to rescue`);
      return;
    }

    // Check if already pushed
    try {
      execSync(`git -C "${repoPath}" rev-parse origin/${branch}`, { stdio: "pipe" });
      // If that succeeds, check if local is ahead
      const ahead = execSync(`git -C "${repoPath}" rev-list --count origin/${branch}..${branch}`, {
        encoding: "utf8", stdio: "pipe"
      }).trim();
      if (ahead === "0") {
        log(`[${taskIdentifier}] Branch ${branch} already pushed — nothing to rescue`);
        return;
      }
      log(`[${taskIdentifier}] Branch ${branch} has ${ahead} unpushed commit(s) — pushing`);
    } catch {
      log(`[${taskIdentifier}] Branch ${branch} not yet pushed — pushing`);
    }

    // Push it
    execSync(`git -C "${repoPath}" push -u origin ${branch}`, { stdio: "pipe" });
    log(`[${taskIdentifier}] Rescued work pushed to origin/${branch}`);
  } catch (err) {
    log(`[${taskIdentifier}] Could not rescue work: ${err.message}`);
  }
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
  markTaskActive(task.identifier);
  log(`[${task.identifier}] Description: ${(task.description || "none").slice(0, 200)}${(task.description || "").length > 200 ? "..." : ""}`);
  if (task.comments?.nodes?.length) {
    log(`[${task.identifier}] ${task.comments.nodes.length} comment(s) from team:`);
    for (const c of task.comments.nodes) {
      log(`[${task.identifier}]   [${c.user?.name || "Unknown"}]: ${c.body.slice(0, 150)}${c.body.length > 150 ? "..." : ""}`);
    }
  }
  log(`[${task.identifier}] Linear URL: ${task.url}`);

  const currentStatus = task.state?.name;
  if (currentStatus !== "In Progress") {
    log(`[${task.identifier}] Updating Linear status → In Progress`);
    await updateIssueStatus(task.id, "In Progress");
  } else {
    log(`[${task.identifier}] Already In Progress — skipping status update`);
  }
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

    // ── Phase 1: Agent makes code changes (with context-reset loop) ────
    let outcome;
    let contextResets = 0;

    while (true) {
      const resumeNote = contextResets > 0
        ? `\n\nRESUMING FROM CONTEXT RESET (session ${contextResets + 1}/${MAX_CONTEXT_RESETS + 1}):\nRead /workspace/signals/spec.md for the full spec and your progress so far.\nContinue from the first unchecked step — do NOT redo completed steps.`
        : "";

      outcome = await runInContainer(task, resumeNote);
      lastStagingPath = outcome.stagingPath;

      if (outcome.exitCode !== 0) {
        log(`[${task.identifier}] Failed with exit code ${outcome.exitCode}`);
        rescueUnpushedWork(outcome.stagingPath, task.identifier);
        await addIssueComment(task.id,
          `❌ Automated implementation failed (exit code ${outcome.exitCode}).\n\n**Error output:**\n\`\`\`\n${outcome.stderr.slice(-1500)}\n\`\`\`\n\nThis task needs manual attention.`
        );
        await updateIssueStatus(task.id, "Todo");
        return;
      }

      // Check for checkpoint signal — agent ran out of context and wants a fresh session
      const checkpointFile = join(outcome.signalsDir, "checkpoint");
      if (existsSync(checkpointFile)) {
        contextResets++;
        log(`[${task.identifier}] Context checkpoint — reset ${contextResets}/${MAX_CONTEXT_RESETS}`);
        try { execSync(`rm -f "${checkpointFile}"`, { stdio: "pipe" }); } catch {}
        cleanupStaging(outcome.stagingPath);
        lastStagingPath = null;

        if (contextResets >= MAX_CONTEXT_RESETS) {
          log(`[${task.identifier}] Max context resets (${MAX_CONTEXT_RESETS}) reached — proceeding`);
          break;
        }
        continue;
      }

      break; // Completed normally
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

    // ── Phase 3: Check for MR and enter review loop ─────────────────────
    const branchName = `task/${task.identifier.toLowerCase()}`;
    let mr = await checkForMR(task.identifier);

    // If Claude exited cleanly but didn't create an MR, create one via API
    if (!mr && outcome.exitCode === 0) {
      log(`[${task.identifier}] No MR found after successful run — creating via API`);
      mr = await createMR(task, branchName);
    }

    if (mr) {
      log(`[${task.identifier}] MR ready: ${mr.web_url}`);
      await updateIssueStatus(task.id, "In Review");
      await addIssueComment(task.id, `🔗 ${GIT_PROVIDER === "github" ? "PR" : "MR"} created: ${mr.web_url}`);

      // Enter the review feedback loop — polls for comments and addresses them
      const reviewResult = await reviewFeedbackLoop(task, mr, lastStagingPath);
      log(`[${task.identifier}] Review loop ended: ${reviewResult}`);

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

    // Rescue any unpushed work before cleaning up
    rescueUnpushedWork(lastStagingPath, task.identifier);

    // Clean up staging directory
    cleanupStaging(lastStagingPath);
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString().slice(0, 19)}] ${msg}`);
}

async function main() {
  log(`Linear Task Runner started (${GIT_PROVIDER === "github" ? "GitHub" : "GitLab"} edition)`);
  log(`Git provider: ${GIT_PROVIDER}`);
  if (GIT_PROVIDER === "github") {
    log(`GitHub: repo=${GITHUB_REPO}`);
  } else {
    log(`GitLab: ${GITLAB_URL} | Project: ${GITLAB_PROJECT_ID}`);
  }
  log(`Agent: ${AGENT_PROVIDER} (${AGENT_PROVIDER === "codex" ? `model: ${CODEX_MODEL}` : `model: ${CLAUDE_MODEL}`})`);
  log(`Agent auth: ${AGENT.authMode}`);
  log(`Linear auth: ${LINEAR_AUTH_MODE === "api-key" ? "API key" : "OAuth (auto-refreshing)"}`);
  log(`Polling every ${POLL_INTERVAL_MS / 1000}s for issues with label="${LINEAR_LABEL}" status="${LINEAR_STATUSES.join(", ")}"`);
  log(`Model: ${CLAUDE_MODEL} | Max turns: ${MAX_TURNS} | Timeout: ${TASK_TIMEOUT_MS / 1000}s`);
  log(`Repo: ${LOCAL_REPO_PATH ? `LOCAL ${LOCAL_REPO_PATH}` : REPO_URL}`);
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
    execSync(`docker build -t ${DOCKER_IMAGE} "${__dirname}"`, { stdio: "inherit" });
    log("Docker image built successfully.");
  } catch (err) {
    log(`Failed to build Docker image: ${err.message}`);
    process.exit(1);
  }

  // Track active tasks so we don't pick them up again
  const activeTasks = new Map(); // identifier → Promise

  // Poll loop
  let pollCount = 0;
  while (true) {
    pollCount++;
    try {
      const activeCount = activeTasks.size;
      log(`Poll #${pollCount}: checking Linear (${activeCount}/${MAX_CONCURRENT_TASKS} tasks active)...`);

      // Debug: show all issues with this label regardless of status
      if (pollCount === 1 || pollCount % 10 === 0) {
        try {
          const debugData = await linearQuery(`
            query DebugIssues($labelName: String!) {
              issues(
                filter: { labels: { name: { eq: $labelName } } }
                first: 20
                orderBy: updatedAt
              ) {
                nodes {
                  identifier
                  title
                  state { name }
                  labels { nodes { name } }
                }
              }
            }
          `, { labelName: LINEAR_LABEL });

          const allIssues = debugData.issues.nodes;
          if (allIssues.length === 0) {
            log(`Poll #${pollCount}: no issues found with label "${LINEAR_LABEL}" in any status.`);
          } else {
            log(`Poll #${pollCount}: all issues with label "${LINEAR_LABEL}":`);
            for (const issue of allIssues) {
              const active = activeTasks.has(issue.identifier) ? " ← ACTIVE" : "";
              const handled = isTaskAlreadyHandled(issue.identifier) ? " ← DONE" : "";
              const match = LINEAR_STATUSES.includes(issue.state.name) ? " ← MATCH" : "";
              log(`  → ${issue.identifier}: ${issue.title} [status: "${issue.state.name}"]${match}${active}${handled}`);
            }
          }
        } catch (err) {
          log(`Poll #${pollCount}: debug query failed: ${err.message}`);
        }
      }

      const tasks = await fetchPendingTasks();

      // Filter out tasks we're already working on (in-memory) or have already handled (on disk)
      const newTasks = tasks.filter((t) => !activeTasks.has(t.identifier) && !isTaskAlreadyHandled(t.identifier));
      // Respect concurrency limit
      const slots = MAX_CONCURRENT_TASKS - activeTasks.size;

      if (newTasks.length === 0 && tasks.length === 0) {
        log(`Poll #${pollCount}: no tasks matching label="${LINEAR_LABEL}" AND status="${LINEAR_STATUSES.join(", ")}". Next poll in ${POLL_INTERVAL_MS / 1000}s.`);
      } else if (newTasks.length === 0) {
        log(`Poll #${pollCount}: ${tasks.length} task(s) found but all already active. Next poll in ${POLL_INTERVAL_MS / 1000}s.`);
      } else if (slots <= 0) {
        log(`Poll #${pollCount}: ${newTasks.length} new task(s) but at concurrency limit (${MAX_CONCURRENT_TASKS}). Next poll in ${POLL_INTERVAL_MS / 1000}s.`);
      } else {
        const toStart = newTasks.slice(0, slots);
        log(`Poll #${pollCount}: starting ${toStart.length} new task(s) (${slots} slots available):`);
        for (const task of toStart) {
          const commentCount = task.comments?.nodes?.length || 0;
          log(`  → ${task.identifier}: ${task.title} (priority: ${task.priority || "none"}, comments: ${commentCount})`);
        }

        // Launch tasks concurrently — each runs in the background
        for (const task of toStart) {
          const taskPromise = processTask(task)
            .then(() => markTaskDone(task.identifier, "completed"))
            .catch((err) => {
              log(`[${task.identifier}] Unhandled error: ${err.message}`);
              markTaskDone(task.identifier, `error: ${err.message}`);
            })
            .finally(() => {
              activeTasks.delete(task.identifier);
              log(`[${task.identifier}] Task finished. Active: ${activeTasks.size}/${MAX_CONCURRENT_TASKS}`);
            });
          activeTasks.set(task.identifier, taskPromise);
        }
      }
    } catch (err) {
      log(`Poll #${pollCount} error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
