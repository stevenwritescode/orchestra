#!/usr/bin/env node
// =============================================================================
// Bug Fixer — GitLab Webhook Listener
//
// Listens for GitLab webhook events on merge requests created by the bug-fixer.
// When a reviewer (or CodeRabbit) posts comments on an auto-fix/* or task/*
// branch MR, this triggers a Claude Code revision session to address feedback.
//
// GitLab webhook events handled:
//   - "note" (MR comments) → triggers revision
//   - "merge_request" (approval) → logs and stops revising
//
// Usage:
//   WEBHOOK_SECRET=xxx GITLAB_TOKEN=glpat-... node webhook-listener.mjs
// =============================================================================

import express from "express";
import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.WEBHOOK_PORT || "3001");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const REPO_DIR = process.env.REPO_DIR || "./repo";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "15");
const MAX_REVISION_ROUNDS = parseInt(process.env.MAX_REVISION_ROUNDS || "3");

// Track revision rounds per MR to enforce the limit
const STATE_DIR = process.env.STATE_DIR || "./state";
mkdirSync(STATE_DIR, { recursive: true });

if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
  console.error("Missing required env vars: GITLAB_TOKEN, GITLAB_PROJECT_ID");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

function ts() {
  return new Date().toISOString().slice(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ─── Get MR discussion threads (unresolved) ─────────────────────────────────
async function getUnresolvedComments(mrIid) {
  const discussions = await gitlabApi("GET", `/merge_requests/${mrIid}/discussions`);

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

// ─── Post a comment on the MR ───────────────────────────────────────────────
async function postMrComment(mrIid, body) {
  await gitlabApi("POST", `/merge_requests/${mrIid}/notes`, { body });
}

// ─── Get revision count for an MR ───────────────────────────────────────────
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

    const prompt = `You are revising code based on merge request review feedback.

You are on branch "${sourceBranch}" which has an open merge request (!${mrIid}).

Review comments to address:
${commentSummary}

Instructions:
1. Read and understand each review comment
2. Make the requested changes to the code
3. Run tests to verify your changes don't break anything
4. Commit with message: "fix: address MR review feedback for !${mrIid}"
5. Push to the branch

Only address what the reviewers asked for. Do not make unrelated changes.
If a comment is just approval/praise with no action needed, skip it.`;

    log(`[MR !${mrIid}] Running revision session with ${comments.length} comment(s)`);

    // Ensure we're on the right branch
    try {
      execSync(`git -C "${REPO_DIR}" fetch origin "${sourceBranch}"`, { stdio: "pipe" });
      execSync(`git -C "${REPO_DIR}" checkout "${sourceBranch}"`, { stdio: "pipe" });
      execSync(`git -C "${REPO_DIR}" pull origin "${sourceBranch}"`, { stdio: "pipe" });
    } catch (err) {
      log(`[MR !${mrIid}] Git checkout error: ${err.message}`);
      reject(err);
      return;
    }

    const proc = spawn("claude", [
      "-p", prompt,
      "--model", CLAUDE_MODEL,
      "--max-turns", String(MAX_TURNS),
      "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
        "Bash(git *)", "Bash(glab *)",
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
      log(`[MR !${mrIid}] Revision session exited with code ${code}`);
      resolve({ exitCode: code, stdout, stderr });
    });

    proc.on("error", (err) => reject(err));
  });
}

// In-progress revisions — prevent concurrent runs on the same MR
const activeRevisions = new Set();

// ─── Handle note (comment) events ───────────────────────────────────────────
async function handleNoteEvent(payload) {
  const note = payload.object_attributes;
  const mr = payload.merge_request;

  // Only handle comments on merge requests
  if (note.noteable_type !== "MergeRequest" || !mr) return;

  const mrIid = mr.iid;
  const sourceBranch = mr.source_branch;
  const commentAuthor = payload.user?.username;

  // Only process comments on branches we manage
  if (!isManagedBranch(sourceBranch)) {
    return;
  }

  // Skip our own comments to avoid loops
  if (commentAuthor === "claude-task-runner") return;

  // Skip if already processing this MR
  if (activeRevisions.has(mrIid)) {
    log(`[MR !${mrIid}] Already revising — skipping`);
    return;
  }

  // Check revision round limit
  const currentRound = getRevisionCount(mrIid);
  if (currentRound >= MAX_REVISION_ROUNDS) {
    log(`[MR !${mrIid}] Max revision rounds (${MAX_REVISION_ROUNDS}) reached — skipping`);
    await postMrComment(mrIid,
      `Automated revision limit reached (${MAX_REVISION_ROUNDS} rounds). Further changes need manual implementation.`
    );
    return;
  }

  log(`[MR !${mrIid}] Review comment from @${commentAuthor} on ${sourceBranch}`);

  // Debounce: wait a few seconds in case multiple comments arrive together
  await new Promise((r) => setTimeout(r, 5000));

  activeRevisions.add(mrIid);

  try {
    // Fetch all unresolved comments (not just this one)
    const allComments = await getUnresolvedComments(mrIid);

    if (allComments.length === 0) {
      log(`[MR !${mrIid}] No actionable comments found`);
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
    log(`[MR !${mrIid}] Revision error: ${err.message}`);
    await postMrComment(mrIid, `Revision error: ${err.message}`).catch(() => {});
  } finally {
    activeRevisions.delete(mrIid);
  }
}

// ─── Handle merge request events ────────────────────────────────────────────
async function handleMergeRequestEvent(payload) {
  const mr = payload.object_attributes;
  const action = mr.action;
  const sourceBranch = mr.source_branch;
  const mrIid = mr.iid;

  if (!isManagedBranch(sourceBranch)) return;

  if (action === "approved") {
    log(`[MR !${mrIid}] Approved — no further revisions needed`);
  } else if (action === "merge") {
    log(`[MR !${mrIid}] Merged`);
    // Clean up state file
    const stateFile = join(STATE_DIR, `mr-${mrIid}.json`);
    if (existsSync(stateFile)) {
      writeFileSync(stateFile, JSON.stringify({ merged: true, mergedAt: new Date().toISOString() }));
    }
  }
}

// ─── Webhook endpoint ──────────────────────────────────────────────────────
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

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    activeRevisions: [...activeRevisions],
  });
});

app.listen(PORT, () => {
  log(`Webhook listener on :${PORT}`);
  log(`GitLab: ${GITLAB_URL} | Project: ${GITLAB_PROJECT_ID}`);
  log(`Max revision rounds: ${MAX_REVISION_ROUNDS}`);
});
