#!/usr/bin/env node
// =============================================================================
// Bug Fixer — API Server
//
// Receives bug reports via POST /api/report, validates them, and drops them
// into a file-based job queue (pending/ directory) for the worker to pick up.
//
// Usage:
//   node api-server.mjs
// =============================================================================

import express from "express";
import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.PORT || "3000");
const QUEUE_DIR = process.env.QUEUE_DIR || "./queue";

// Ensure queue directories exist
for (const dir of ["pending", "processing", "done", "rejected"]) {
  mkdirSync(join(QUEUE_DIR, dir), { recursive: true });
}

const app = express();
app.use(express.json({ limit: "100kb" }));

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", queue: QUEUE_DIR });
});

// ─── Submit a bug report ────────────────────────────────────────────────────
app.post("/api/report", (req, res) => {
  const { title, description, steps_to_reproduce, url, user_agent, error_message } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: "title and description are required" });
  }

  const id = randomUUID();
  const report = {
    id,
    title,
    description,
    steps_to_reproduce: steps_to_reproduce || null,
    url: url || null,
    user_agent: user_agent || null,
    error_message: error_message || null,
    submitted_at: new Date().toISOString(),
  };

  const filePath = join(QUEUE_DIR, "pending", `${id}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));

  console.log(`[${ts()}] New report: ${id} — ${title}`);
  res.status(201).json({ id, status: "queued" });
});

// ─── List queue status ──────────────────────────────────────────────────────
app.get("/api/queue", (_req, res) => {
  const counts = {};
  for (const dir of ["pending", "processing", "done", "rejected"]) {
    try {
      counts[dir] = readdirSync(join(QUEUE_DIR, dir)).filter((f) => f.endsWith(".json")).length;
    } catch {
      counts[dir] = 0;
    }
  }
  res.json(counts);
});

// ─── Get report status ──────────────────────────────────────────────────────
app.get("/api/report/:id", (req, res) => {
  const { id } = req.params;

  for (const dir of ["pending", "processing", "done", "rejected"]) {
    const filePath = join(QUEUE_DIR, dir, `${id}.json`);
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      return res.json({ ...data, status: dir });
    } catch {
      // Not in this directory
    }
  }

  res.status(404).json({ error: "report not found" });
});

function ts() {
  return new Date().toISOString().slice(0, 19);
}

app.listen(PORT, () => {
  console.log(`[${ts()}] Bug report API listening on :${PORT}`);
  console.log(`[${ts()}] Queue directory: ${QUEUE_DIR}`);
});
