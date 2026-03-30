# Bug Fixer Pipeline (GitLab)

Automated bug report → triage → fix → merge request pipeline using Claude Code and GitLab.

## How It Works

```
Website → POST /api/report → Queue → Worker → Claude Code → Draft MR
                                       │
                                    Triage (cheap, 1 turn)
                                       │
                               bug? ───┤──── not bug? → rejected/
                                       │
                                    Fix (full session)
                                       │
                                    Draft MR on GitLab
                                       │
                              Webhook listener ←── GitLab MR events
                                       │
                              Claude Code revision ──→ push fix
```

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env with your API keys and GitLab project details

# 2. Set up GitLab webhook
# Go to your GitLab project → Settings → Webhooks
# URL: https://your-server:3001/webhook/gitlab
# Secret token: (same as WEBHOOK_SECRET in .env)
# Triggers: ✓ Comments  ✓ Merge request events

# 3. Start
docker compose up -d

# 4. Submit a test bug report
curl -X POST http://localhost:3000/api/report \
  -H "Content-Type: application/json" \
  -d '{"title": "Login button broken", "description": "Clicking login does nothing on Firefox"}'

# 5. Watch logs
docker compose logs -f worker
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/report` | Submit a bug report |
| GET | `/api/report/:id` | Get report status |
| GET | `/api/queue` | Queue counts by status |
| GET | `/health` | API health check |

### POST /api/report

```json
{
  "title": "Required: short summary",
  "description": "Required: detailed description",
  "steps_to_reproduce": "Optional",
  "url": "Optional: page URL where bug occurred",
  "user_agent": "Optional: browser info",
  "error_message": "Optional: any error text"
}
```

## Architecture

### File-Based Queue

Reports flow through directories: `pending/` → `processing/` → `done/` or `rejected/`

Each report is a JSON file named `{uuid}.json`. The worker moves files atomically between directories.

### Triage Stage

A single-turn Claude Code call classifies reports as: `bug`, `feature_request`, `user_error`, `unclear`, or `duplicate`. Non-bugs go to `rejected/` — this filters out 60-80% of junk before spending money on fixes.

### Fix Stage

For real bugs, Claude Code runs in the repo with restricted tools (file ops, git, test commands). It reads the codebase, finds the root cause, writes a fix, runs tests, and commits to an `auto-fix/{report-id}` branch.

### Review Feedback Loop

The webhook listener catches GitLab MR comment events. When a reviewer (or CodeRabbit) posts feedback on a managed branch, Claude Code runs a revision session to address the comments. This repeats up to `MAX_REVISION_ROUNDS` (default: 3).

## GitLab Setup

### Required Token Scopes

Your `GITLAB_TOKEN` needs the `api` scope, which covers:
- Creating merge requests
- Posting comments
- Reading discussions

### Webhook Configuration

In your GitLab project → Settings → Webhooks:
- **URL**: `https://your-server:3001/webhook/gitlab`
- **Secret token**: Same value as `WEBHOOK_SECRET` in your `.env`
- **Triggers**: Check "Comments" and "Merge request events"

GitLab verifies webhooks via the `X-Gitlab-Token` header (simple token match, not HMAC).
