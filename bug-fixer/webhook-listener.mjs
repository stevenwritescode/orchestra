#!/usr/bin/env node
// =============================================================================
// Bug Fixer — GitHub / GitLab Webhook Listener
//
// Listens for webhook events on merge/pull requests created by the bug-fixer.
// When a reviewer (or CodeRabbit) posts comments on an auto-fix/* or task/*
// branch MR/PR, this triggers a Claude Code revision session to address feedback.
//
// Webhook events handled:
//   GitLab:
//     - "note" (MR comments) → triggers revision
//     - "merge_request" (approval / merge) → logs and stops revising
//   GitHub:
//     - "pull_request_review" (submitted review) → triggers revision
//     - "issue_comment" (PR comment) → triggers revision
//     - "pull_request" (merged) → logs and stops revising
//
// Usage:
//   GIT_PROVIDER=gitlab WEBHOOK_SECRET=xxx GITLAB_TOKEN=glpat-... node webhook-listener.mjs
//   GIT_PROVIDER=github WEBHOOK_SECRET=xxx GITHUB_TOKEN=ghp_... GITHUB_REPO=owner/repo node webhook-listener.mjs
// =============================================================================

import express from "express";
import crypto from "crypto";
import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GIT_PROVIDER = process.env.GIT_PROVIDER || "gitlab"; // "github" | "gitlab"
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
const REPO_DIR = process.env.REPO_DIR || "./repo";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "15");
const MAX_REVISION_ROUNDS = parseInt(process.env.MAX_REVISION_ROUNDS || "3");

// Track revision rounds per MR to enforce the limit
const STATE_DIR = process.env.STATE_DIR || "./state";
mkdirSync(STATE_DIR, { recursive: true });

// Validate provider-specific env vars
if (GIT_PROVIDER === "gitlab") {
  if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
    console.error("Missing required env vars: GITLAB_TOKEN, GITLAB_PROJECT_ID");
    process.exit(1);
  }
} else if (GIT_PROVIDER === "github") {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.error("Missing required env vars: GITHUB_TOKEN, GITHUB_REPO");
    process.exit(1);
  }
} else {
  console.error(`Unknown GIT_PROVIDER: ${GIT_PROVIDER} (expected "github" or "gitlab")`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

function ts() {
  return new Date().toISOString().slice(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── HMAC signature verification for GitHub webhooks ────────────────────────
function verifyGitHubSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature) return !WEBHOOK_SECRET;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Git API helper ─────────────────────────────────────────────────────────
async function gitApi(method, path, body = null) {
  let url, headers;

  if (GIT_PROVIDER === "github") {
    url = `https://api.github.com/repos/${GITHUB_REPO}${path}`;
    headers = {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${GIT_PROVIDER} API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ─── Get unresolved / actionable comments ───────────────────────────────────
async function getUnresolvedComments(mrIid) {
  if (GIT_PROVIDER === "github") {
    // Fetch both review comments (on diffs) and issue comments (general)
    const [reviewComments, issueComments] = await Promise.all([
      gitApi("GET", `/pulls/${mrIid}/comments`),
      gitApi("GET", `/issues/${mrIid}/comments`),
    ]);

    const comments = [];
    for (const c of [...reviewComments, ...issueComments]) {
      // Skip the bot's own comments
      if (c.user?.login === "claude-task-runner") continue;

      comments.push({
        id: c.id,
        author: c.user?.login || "unknown",
        body: c.body,
        created_at: c.created_at,
      });
    }
    return comments;
  }

  // GitLab path — unchanged
  const discussions = await gitApi("GET", `/merge_requests/${mrIid}/discussions`);

  const comments = [];
  for (const disc of discussions) {
    for (const note of disc.notes) {
      // Skip system notes and resolved threads
      if (note.system) continue;
      if (note.resolvable && note.resolved) continue;
      // Skip the bot's own comments
      if (note.author?.username === "claude-task-runner") continue;

      comments.push({
        id: note.id,
        author: note.author?.username || "unknown",
        body: note.body,
        created_at: note.created_at,
        discussion_id: disc.id,
        resolvable: note.resolvable,
      });
    }
  }
  return comments;
}

// ─── Post a comment on the MR / PR ─────────────────────────────────────────
async function postMrComment(mrIid, body) {
  if (GIT_PROVIDER === "github") {
    await gitApi("POST", `/issues/${mrIid}/comments`, { body });
  } else {
    await gitApi("POST", `/merge_requests/${mrIid}/notes`, { body });
  }
}

// ─── Get revision count for an MR / PR ──────────────────────────────────────
function getRevisionCount(mrIid) {
  const stateFile = join(STATE_DIR, `mr-${mrIid}.json`);
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    return state.revisionCount || 0;
  }
  return 0;
}

function incrementRevisionCount(mrIid) {
  const stateFile = join(STATE_DIR, `mr-${mrIid}.json`);
  let state = { revisionCount: 0 };
  if (existsSync(stateFile)) {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  }
  state.revisionCount = (state.revisionCount || 0) + 1;
  state.lastRevision = new Date().toISOString();
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return state.revisionCount;
}

// ─── Check if a branch is one we manage ─────────────────────────────────────
function isManagedBranch(branchName) {
  return branchName?.startsWith("auto-fix/") || branchName?.startsWith("task/");
}

// ─── Run Claude Code revision session ───────────────────────────────────────
function runRevisionSession(mrIid, sourceBranch, comments) {
  return new Promise((resolve, reject) => {
    const commentSummary = comments
      .map((c) => `@${c.author}: ${c.body}`)
      .join("\n\n---\n\n");

    const mrRef = GIT_PROVIDER === "github" ? `#${mrIid}` : `!${mrIid}`;
    const cliTool = GIT_PROVIDER === "github" ? "Bash(gh *)" : "Bash(glab *)";

    const prompt = `You are revising code based on merge request review feedback.

You are on branch "${sourceBranch}" which has an open merge request (${mrRef}).

Review comments to address:
${commentSummary}

Instructions:
1. Read and understand each review comment
2. Make the requested changes to the code
3. Run tests to verify your changes don't break anything
4. Commit with message: "fix: address MR review feedback for ${mrRef}"
5. Push to the branch

Only address what the reviewers asked for. Do not make unrelated changes.
If a comment is just approval/praise with no action needed, skip it.`;

    log(`[MR ${mrRef}] Running revision session with ${comments.length} comment(s)`);

    // Ensure we're on the right branch
    try {
      execSync(`git -C "${REPO_DIR}" fetch origin "${sourceBranch}"`, { stdio: "pipe" });
      execSync(`git -C "${REPO_DIR}" checkout "${sourceBranch}"`, { stdio: "pipe" });
      execSync(`git -C "${REPO_DIR}" pull origin "${sourceBranch}"`, { stdio: "pipe" });
    } catch (err) {
      log(`[MR ${mrRef}] Git checkout error: ${err.message}`);
      reject(err);
      return;
    }

    const proc = spawn("claude", [
      "-p", prompt,
      "--model", CLAUDE_MODEL,
      "--max-turns", String(MAX_TURNS),
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
        "Bash(git *)", cliTool,
        "Bash(npm test*)", "Bash(npm run *)",
        "Bash(npx *)", "Bash(node *)",
        "Bash(pytest*)", "Bash(python *)",
        "Bash(cargo test*)", "Bash(go test*)",
        "Bash(make test*)",
      "--output-format", "json",
    ], {
      cwd: REPO_DIR,
      env: { ...process.env },
      timeout: 600_000, // 10 min
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      log(`[MR ${mrRef}] Revision session exited with code ${code}`);
      resolve({ exitCode: code, stdout, stderr });
    });

    proc.on("error", (err) => reject(err));
  });
}

// In-progress revisions — prevent concurrent runs on the same MR
const activeRevisions = new Set();

// ─── Shared handler: process a comment event ────────────────────────────────
async function handleCommentEvent(mrIid, sourceBranch, commentAuthor) {
  const mrRef = GIT_PROVIDER === "github" ? `#${mrIid}` : `!${mrIid}`;

  // Only process comments on branches we manage
  if (!isManagedBranch(sourceBranch)) {
    return;
  }

  // Skip our own comments to avoid loops
  if (commentAuthor === "claude-task-runner") return;

  // Skip if already processing this MR
  if (activeRevisions.has(mrIid)) {
    log(`[MR ${mrRef}] Already revising — skipping`);
    return;
  }

  // Check revision round limit
  const currentRound = getRevisionCount(mrIid);
  if (currentRound >= MAX_REVISION_ROUNDS) {
    log(`[MR ${mrRef}] Max revision rounds (${MAX_REVISION_ROUNDS}) reached — skipping`);
    await postMrComment(mrIid,
      `Automated revision limit reached (${MAX_REVISION_ROUNDS} rounds). Further changes need manual implementation.`
    );
    return;
  }

  log(`[MR ${mrRef}] Review comment from @${commentAuthor} on ${sourceBranch}`);

  // Debounce: wait a few seconds in case multiple comments arrive together
  await new Promise((r) => setTimeout(r, 5000));

  activeRevisions.add(mrIid);

  try {
    // Fetch all unresolved comments (not just this one)
    const allComments = await getUnresolvedComments(mrIid);

    if (allComments.length === 0) {
      log(`[MR ${mrRef}] No actionable comments found`);
      return;
    }

    const round = incrementRevisionCount(mrIid);
    await postMrComment(mrIid,
      `Starting automated revision (round ${round}/${MAX_REVISION_ROUNDS}) to address ${allComments.length} comment(s)...`
    );

    const result = await runRevisionSession(mrIid, sourceBranch, allComments);

    if (result.exitCode === 0) {
      // Push the changes
      try {
        execSync(`git -C "${REPO_DIR}" push origin "${sourceBranch}"`, { stdio: "pipe" });
        await postMrComment(mrIid,
          `Revision round ${round} complete. Pushed changes to address review feedback. Please re-review.`
        );
      } catch (pushErr) {
        await postMrComment(mrIid,
          `Revision completed but push failed: ${pushErr.message}`
        );
      }
    } else {
      await postMrComment(mrIid,
        `Revision round ${round} failed (exit code ${result.exitCode}). Manual changes may be needed.\n\n\`\`\`\n${result.stderr.slice(-500)}\n\`\`\``
      );
    }
  } catch (err) {
    log(`[MR ${mrRef}] Revision error: ${err.message}`);
    await postMrComment(mrIid, `Revision error: ${err.message}`).catch(() => {});
  } finally {
    activeRevisions.delete(mrIid);
  }
}

// ─── Shared handler: process a merge event ──────────────────────────────────
async function handleMergeEvent(mrIid, sourceBranch) {
  const mrRef = GIT_PROVIDER === "github" ? `#${mrIid}` : `!${mrIid}`;

  if (!isManagedBranch(sourceBranch)) return;

  log(`[MR ${mrRef}] Merged`);
  // Clean up state file
  const stateFile = join(STATE_DIR, `mr-${mrIid}.json`);
  if (existsSync(stateFile)) {
    writeFileSync(stateFile, JSON.stringify({ merged: true, mergedAt: new Date().toISOString() }));
  }
}

// ─── Handle GitLab note (comment) events ────────────────────────────────────
async function handleNoteEvent(payload) {
  const note = payload.object_attributes;
  const mr = payload.merge_request;

  // Only handle comments on merge requests
  if (note.noteable_type !== "MergeRequest" || !mr) return;

  const mrIid = mr.iid;
  const sourceBranch = mr.source_branch;
  const commentAuthor = payload.user?.username;

  await handleCommentEvent(mrIid, sourceBranch, commentAuthor);
}

// ─── Handle GitLab merge request events ─────────────────────────────────────
async function handleMergeRequestEvent(payload) {
  const mr = payload.object_attributes;
  const action = mr.action;
  const sourceBranch = mr.source_branch;
  const mrIid = mr.iid;

  if (!isManagedBranch(sourceBranch)) return;

  if (action === "approved") {
    log(`[MR !${mrIid}] Approved — no further revisions needed`);
  } else if (action === "merge") {
    await handleMergeEvent(mrIid, sourceBranch);
  }
}

// ─── GitLab Webhook endpoint ────────────────────────────────────────────────
app.post("/webhook/gitlab", (req, res) => {
  // Verify webhook secret via X-Gitlab-Token header
  if (WEBHOOK_SECRET) {
    const token = req.headers["x-gitlab-token"];
    if (token !== WEBHOOK_SECRET) {
      log("Webhook rejected: invalid token");
      return res.status(401).json({ error: "invalid token" });
    }
  }

  const eventType = req.headers["x-gitlab-event"];
  const payload = req.body;

  log(`Webhook received: ${eventType}`);

  // Respond immediately, process async
  res.status(200).json({ status: "accepted" });

  // Route to handler
  switch (payload.object_kind) {
    case "note":
      handleNoteEvent(payload).catch((err) =>
        log(`Error handling note event: ${err.message}`)
      );
      break;
    case "merge_request":
      handleMergeRequestEvent(payload).catch((err) =>
        log(`Error handling MR event: ${err.message}`)
      );
      break;
    default:
      log(`Ignoring event type: ${payload.object_kind}`);
  }
});

// ─── GitHub Webhook endpoint ────────────────────────────────────────────────
app.post("/webhook/github", (req, res) => {
  // Verify HMAC signature
  const signature = req.headers["x-hub-signature-256"];
  if (!verifyGitHubSignature(req.rawBody, signature)) {
    log("GitHub webhook rejected: invalid signature");
    return res.status(401).json({ error: "invalid signature" });
  }

  const eventType = req.headers["x-github-event"];
  const payload = req.body;

  log(`GitHub webhook received: ${eventType} (action: ${payload.action || "n/a"})`);

  // Respond immediately, process async
  res.status(200).json({ status: "accepted" });

  if (eventType === "pull_request_review") {
    // A review was submitted — treat as a comment if the review body is non-empty
    if (payload.action === "submitted" && payload.review?.body) {
      const prNumber = payload.pull_request?.number;
      const sourceBranch = payload.pull_request?.head?.ref;
      const commentAuthor = payload.review?.user?.login;

      handleCommentEvent(prNumber, sourceBranch, commentAuthor).catch((err) =>
        log(`Error handling GitHub review event: ${err.message}`)
      );
    }
  } else if (eventType === "issue_comment") {
    // Only handle comments on pull requests (issues with a pull_request key)
    if (payload.issue?.pull_request) {
      const prNumber = payload.issue.number;
      const commentAuthor = payload.comment?.user?.login;

      // GitHub issue_comment doesn't include head ref directly; fetch it
      gitApi("GET", `/pulls/${prNumber}`)
        .then((pr) => {
          const sourceBranch = pr.head?.ref;
          return handleCommentEvent(prNumber, sourceBranch, commentAuthor);
        })
        .catch((err) =>
          log(`Error handling GitHub issue_comment event: ${err.message}`)
        );
    }
  } else if (eventType === "pull_request") {
    if (payload.action === "closed" && payload.pull_request?.merged === true) {
      const prNumber = payload.pull_request.number;
      const sourceBranch = payload.pull_request.head?.ref;

      handleMergeEvent(prNumber, sourceBranch).catch((err) =>
        log(`Error handling GitHub merge event: ${err.message}`)
      );
    }
  }
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    provider: GIT_PROVIDER,
    activeRevisions: [...activeRevisions],
  });
});

app.listen(PORT, () => {
  log(`Webhook listener on :${PORT} (provider: ${GIT_PROVIDER})`);
  if (GIT_PROVIDER === "gitlab") {
    log(`GitLab: ${GITLAB_URL} | Project: ${GITLAB_PROJECT_ID}`);
  } else {
    log(`GitHub: ${GITHUB_REPO}`);
  }
  log(`Max revision rounds: ${MAX_REVISION_ROUNDS}`);
});
