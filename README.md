# Orchestra GL

Autonomous coding pipelines that use [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to fix bugs and implement tasks, opening draft merge requests on GitLab.

Two independent pipelines that can run together or separately:

```
                    ┌──────────────────────────────────────────────────┐
                    │                                                  │
  Bug reports ────► │  bug-fixer/                                      │
  (POST /api/report)│    1. Triage (cheap 1-turn Claude call)          │
                    │    2. Fix (full Claude Code session)             │
                    │    3. Draft MR on GitLab                    ─────┼──► GitLab MRs
                    │    4. Revise based on review comments            │
                    │                                                  │
                    ├──────────────────────────────────────────────────┤
                    │                                                  │
  Linear issues ──► │  linear-task-runner/                             │
  (label: autofix)  │    1. Poll Linear for tasks                      │
                    │    2. Spawn sandboxed Docker container           │
                    │    3. Claude Code implements + tests        ─────┼──► GitLab MRs
                    │    4. Update Linear issue status                 │
                    │    5. Destroy container                          │
                    │                                                  │
                    └──────────────────────────────────────────────────┘
```

## How it works

### Pipeline 1: Bug Report → Fix → MR ([`bug-fixer/`](bug-fixer/))

An Express API receives bug reports from your website. Each report goes through two stages:

1. **Triage** — A single-turn `claude -p` call classifies the report as `bug`, `feature_request`, `user_error`, `unclear`, or `duplicate`. This filters out ~60-80% of noise before spending money on fixes.
2. **Fix** — For real bugs, Claude Code runs in the repo with restricted tool access. It reads the codebase, finds the root cause, writes a fix, runs tests, commits to an `auto-fix/{id}` branch, and opens a draft MR on GitLab.

A webhook listener catches MR review comments (from humans or [CodeRabbit](https://coderabbit.ai/)) and triggers Claude Code revision sessions to address feedback, pushing new commits until approved or a round limit is hit.

### Pipeline 2: Linear → Implement → MR ([`linear-task-runner/`](linear-task-runner/))

An orchestrator polls Linear for issues with a specific label (default: `autofix`). For each task:

1. Spawns a fresh Docker container with Claude Code and `--dangerously-skip-permissions`
2. Claude reads the codebase, implements the task, runs tests, opens a draft MR
3. The orchestrator updates the Linear issue (Todo → In Progress → In Review) with the MR link
4. Container is destroyed — no state leakage between tasks

Docker sandboxing makes `--dangerously-skip-permissions` safe: filesystem isolation, iptables firewall (whitelist only), non-root user, resource limits, no host Docker socket access.

## Backend testing

Both pipelines support testing your backend Docker container after Claude makes changes. Two modes:

**Orchestrator-mediated** — The agent has no Docker access. After it commits, the orchestrator builds and starts the backend, runs tests, and if they fail, feeds the output back to a new Claude session to fix. Repeats up to `MAX_FIX_ITERATIONS`.

**Live access** — The agent can `curl` the backend directly on the host. A firewall pinhole allows traffic only to specific ports on the Docker host gateway. The agent signals the orchestrator to rebuild by writing to a shared `/workspace/signals/` directory, then polls for completion.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Docker
- A GitLab personal access token with `api` scope
- An Anthropic API key
- For the Linear pipeline: a Linear API key or OAuth app credentials

## Quick start

### Bug fixer

```bash
cd bug-fixer
cp .env.example .env
# Edit .env with your keys

# Start
docker compose up -d

# Submit a test report
curl -X POST http://localhost:3000/api/report \
  -H "Content-Type: application/json" \
  -d '{"title": "Login broken on Firefox", "description": "Clicking login does nothing"}'

# Watch
docker compose logs -f worker
```

Set up a GitLab webhook (project → Settings → Webhooks) pointing at `https://your-server:3001/webhook/gitlab` with the same secret token, triggering on Comments and Merge request events.

### Linear task runner

```bash
cd linear-task-runner
cp .env.example .env
# Edit .env with your keys
```

**Linear auth** — two options:

```bash
# Option A: API key (if your org allows it)
# Just set LINEAR_API_KEY in .env

# Option B: OAuth (if your org requires it)
# Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in .env, then:
node linear-oauth.mjs setup   # one-time browser authorization
node linear-oauth.mjs check   # verify it worked
```

**Run:**

```bash
# Direct (simplest for testing)
node orchestrator.mjs

# Or via Docker Compose (for running as a service)
docker compose up -d
```

Create an issue in Linear with the `autofix` label and a clear description. The orchestrator picks it up on the next poll cycle.

### Using a local repo

By default, the pipelines clone from `REPO_URL`. If you have a local checkout you want to use instead (preserving node_modules, config, etc.):

```env
LOCAL_REPO_PATH=/path/to/your/local/repo
REPO_URL=https://gitlab.com/group/project.git  # still needed for push
```

The orchestrator copies the repo into a staging directory for each task (your working tree is never modified).

## Configuration

See [`.env.example`](bug-fixer/.env.example) and [`linear-task-runner/.env.example`](linear-task-runner/.env.example) for all available options.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude Code API key |
| `GITLAB_TOKEN` | Yes | GitLab PAT with `api` scope |
| `GITLAB_PROJECT_ID` | Yes | Numeric ID or `group/project` path |
| `REPO_URL` | Yes* | Git clone URL |
| `LOCAL_REPO_PATH` | No | Use a local checkout instead of cloning |
| `LINEAR_API_KEY` | † | Linear API key |
| `LINEAR_CLIENT_ID` | † | Linear OAuth client ID |
| `LINEAR_CLIENT_SECRET` | † | Linear OAuth client secret |
| `WEBHOOK_SECRET` | No | GitLab webhook token verification |
| `CLAUDE_MODEL` | No | Model to use (default: `sonnet`) |
| `BACKEND_DOCKER_COMPOSE` | No | Enable backend Docker testing |
| `BACKEND_LIVE_ACCESS` | No | Let agent curl the backend directly |

\* Not required if `LOCAL_REPO_PATH` is set
† One of API key or OAuth credentials required for the Linear pipeline

## Security model

```
Host
  ├── Orchestrator (has Docker socket — runs on your server)
  │     └── Task Container (isolated)
  │           ├── iptables firewall: only GitLab, npm, Anthropic API
  │           ├── Non-root user (claude-runner)
  │           ├── 4GB RAM / 2 CPU limit
  │           ├── Ephemeral (destroyed after each task)
  │           └── No Docker socket access
  │
  ├── Bug Fixer Worker (restricted --allowedTools)
  │     └── Can only: read/write files, git, run tests
  │
  └── Webhook Listener
        └── Validates X-Gitlab-Token header
        └── Only processes comments on auto-fix/* and task/* branches
```

The agent can push to GitLab (it needs to for MRs). Mitigate with: project-scoped tokens, protected branches, and reviewing all MRs before merging.

## License

MIT
