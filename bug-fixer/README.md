# Bug Fixer Pipeline

Automated bug report → triage → fix → MR/PR pipeline using an AI agent (Claude Code or Codex). Supports both GitLab and GitHub.

## How It Works

```
Website → POST /api/report → Queue → Worker → Agent → Draft MR/PR
                                      │
                                   Triage (cheap, 1 turn)
                                      │
                              bug? ───┤──── not bug? → rejected/
                                      │
                                   Fix (full session)
                                      │
                                   Draft MR/PR
                                      │
                             Webhook listener ←── GitLab/GitHub events
                                      │
                              Agent revision ──→ push fix
```

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env — set GIT_PROVIDER, AGENT_PROVIDER, your tokens, and project details

# 2. Set up webhook in your git provider (see below)

# 3. Start
docker compose up -d

# 4. Submit a test bug report
curl -X POST http://localhost:3000/api/report \
  -H "Content-Type: application/json" \
  -d '{"title": "Login button broken", "description": "Clicking login does nothing on Firefox"}'

# 5. Watch logs
docker compose logs -f worker
```

## Webhook Setup

### GitLab

Project → Settings → Webhooks:
- **URL**: `https://your-server:3001/webhook/gitlab`
- **Secret token**: same as `WEBHOOK_SECRET` in `.env`
- **Triggers**: Comments + Merge request events

GitLab verifies via `X-Gitlab-Token` header.

### GitHub

Repo → Settings → Webhooks:
- **URL**: `https://your-server:3001/webhook/github`
- **Secret**: same as `WEBHOOK_SECRET` in `.env`
- **Events**: Pull request reviews + Issue comments + Pull requests

GitHub verifies via `X-Hub-Signature-256` (HMAC-SHA256).

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

A single-turn agent call classifies reports as: `bug`, `feature_request`, `user_error`, `unclear`, or `duplicate`. Non-bugs go to `rejected/` — this filters out 60-80% of noise before spending money on fixes.

### Fix Stage

For real bugs, the agent runs in the repo with restricted tools (file ops, git, test commands). It reads the codebase, finds the root cause, writes a fix, runs tests, and commits to an `auto-fix/{report-id}` branch.

### Review Feedback Loop

The webhook listener catches MR/PR comment events. When a reviewer (human or [CodeRabbit](https://coderabbit.ai/)) posts feedback on a managed branch, the agent runs a revision session to address the comments. This repeats up to `MAX_REVISION_ROUNDS` (default: 3).

## Agent Providers

Set `AGENT_PROVIDER` in `.env`:

| Provider | Value | Requires |
|----------|-------|---------|
| Claude Code (default) | `claude` | `ANTHROPIC_API_KEY` or `claude login` |
| OpenAI Codex | `codex` | `OPENAI_API_KEY` or `codex login` |

## Token Scopes

- **GitLab**: `GITLAB_TOKEN` needs `api` scope (create MRs, post comments, read discussions)
- **GitHub**: `GITHUB_TOKEN` needs `repo` scope
