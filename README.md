# Orchestra

Autonomous coding pipelines that use AI agents (Claude Code, OpenAI Codex, or others) to fix bugs and implement tasks, opening draft merge requests on GitLab or pull requests on GitHub.

Set `GIT_PROVIDER=github` or `GIT_PROVIDER=gitlab` and `AGENT_PROVIDER=claude` or `AGENT_PROVIDER=codex` — everything else adapts automatically.

Three components that can run together or separately:

```
                    ┌──────────────────────────────────────────────────┐
                    │                                                  │
  Bug reports ────► │  bug-fixer/                                      │
  (POST /api/report)│    1. Triage (cheap 1-turn agent call)           │
                    │    2. Fix (full agent session)                   │
                    │    3. Draft MR/PR                           ─────┼──► GitLab MRs
                    │    4. Revise based on review comments            │    or GitHub PRs
                    │                                                  │
                    ├──────────────────────────────────────────────────┤
                    │                                                  │
  Linear issues ──► │  linear-task-runner/                             │
  (label: autofix)  │    1. Poll Linear for tasks                      │
                    │    2. Spawn sandboxed Docker container           │
                    │    3. Agent implements + tests              ─────┼──► GitLab MRs
                    │    4. Update Linear issue status                 │    or GitHub PRs
                    │    5. Destroy container                          │
                    │                                                  │
                    ├──────────────────────────────────────────────────┤
                    │                                                  │
  You ────────────► │  manual-runner/                                  │
  (CLI flags or     │    1. Specify branch + instructions              │
   interactive)     │    2. Spawn sandboxed Docker container      ─────┼──► GitLab MRs
                    │    3. Agent implements + opens MR                │    or GitHub PRs
                    │                                                  │
                    └──────────────────────────────────────────────────┘
```

## How it works

### Pipeline 1: Bug Report → Fix → MR/PR ([`bug-fixer/`](bug-fixer/))

An Express API receives bug reports from your website. Each report goes through two stages:

1. **Triage** — A single-turn agent call classifies the report as `bug`, `feature_request`, `user_error`, `unclear`, or `duplicate`. This filters out ~60-80% of noise before spending money on fixes.
2. **Fix** — For real bugs, the agent runs in the repo with restricted tool access. It reads the codebase, finds the root cause, writes a fix, runs tests, commits to an `auto-fix/{id}` branch, and opens a draft MR/PR.

A webhook listener catches review comments (from humans or [CodeRabbit](https://coderabbit.ai/)) and triggers agent revision sessions to address feedback, pushing new commits until approved or a round limit is hit. Supports both GitLab (`/webhook/gitlab`) and GitHub (`/webhook/github`) webhook formats.

See [`bug-fixer/README.md`](bug-fixer/README.md) for full setup.

### Pipeline 2: Manual → Implement → MR/PR ([`manual-runner/`](manual-runner/))

Spin up a sandboxed agent container on demand with your own instructions. Same Docker isolation as the linear-task-runner, but you drive it manually via CLI flags or interactive prompts.

```bash
# Check out an existing branch
node manual-runner/run.mjs -b feature/auth -i "Add unit tests for the auth middleware"

# Create a new branch
node manual-runner/run.mjs -nb fix/login-bug -i "The login button doesn't work on Firefox"

# Interactive mode
node manual-runner/run.mjs
```

See [`manual-runner/README.md`](manual-runner/README.md) for full usage.

### Pipeline 3: Linear → Implement → MR/PR ([`linear-task-runner/`](linear-task-runner/))

An orchestrator polls Linear for issues with a specific label (default: `autofix`). For each task:

1. Spawns a fresh Docker container with the agent CLI and `--dangerously-skip-permissions`
2. The agent reads the codebase, implements the task, runs tests, opens a draft MR/PR
3. The orchestrator updates the Linear issue (Todo → In Progress → In Review) with the MR/PR link
4. Container is destroyed — no state leakage between tasks

Docker sandboxing makes `--dangerously-skip-permissions` safe: filesystem isolation, iptables firewall (whitelist only), non-root user, resource limits, no host Docker socket access.

See [`linear-task-runner/README.md`](linear-task-runner/README.md) for full setup and mid-task messaging.

## Agent providers

Set `AGENT_PROVIDER` in your `.env` to switch between agents:

| Provider | Value | Requires |
|----------|-------|---------|
| Claude Code (default) | `claude` | `ANTHROPIC_API_KEY` or `claude login` |
| OpenAI Codex | `codex` | `OPENAI_API_KEY` or `codex login` |

## Backend testing

Both pipelines support testing your backend Docker container after the agent makes changes. Two modes:

**Orchestrator-mediated** — The agent has no Docker access. After it commits, the orchestrator builds and starts the backend, runs tests, and if they fail, feeds the output back to a new agent session to fix. Repeats up to `MAX_FIX_ITERATIONS`.

**Live access** — The agent can `curl` the backend directly on the host. A firewall pinhole allows traffic only to specific ports on the Docker host gateway. The agent signals the orchestrator to rebuild by writing to a shared `/workspace/signals/` directory, then polls for completion.

## Prerequisites

- Docker
- **Claude**: An Anthropic API key, or run `claude login`
- **Codex**: An OpenAI API key, or run `codex login`
- **GitLab**: A personal access token with `api` scope
- **GitHub**: A personal access token with `repo` scope
- For the Linear pipeline: a Linear API key or OAuth app credentials

## Quick start

### Bug fixer

```bash
cd bug-fixer
cp .env.example .env
# Edit .env — set GIT_PROVIDER, AGENT_PROVIDER, your token, and other keys

# Start
docker compose up -d

# Submit a test report
curl -X POST http://localhost:3000/api/report \
  -H "Content-Type: application/json" \
  -d '{"title": "Login broken on Firefox", "description": "Clicking login does nothing"}'

# Watch
docker compose logs -f worker
```

Set up a webhook in your git provider:

- **GitLab**: Project → Settings → Webhooks → URL: `https://your-server:3001/webhook/gitlab`, secret token, triggers: Comments + Merge request events
- **GitHub**: Repo → Settings → Webhooks → URL: `https://your-server:3001/webhook/github`, secret, events: Pull request reviews + Issue comments + Pull requests

### Linear task runner

```bash
cd linear-task-runner
cp .env.example .env
# Edit .env — set GIT_PROVIDER, AGENT_PROVIDER, your token, and other keys
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
REPO_URL=https://github.com/org/repo.git  # still needed for push
```

The orchestrator copies the repo into a staging directory for each task (your working tree is never modified).

## Configuration

See [`bug-fixer/.env.example`](bug-fixer/.env.example) and [`linear-task-runner/.env.example`](linear-task-runner/.env.example) for all available options.

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_PROVIDER` | No | `claude` (default) or `codex` |
| `GIT_PROVIDER` | Yes | `github` or `gitlab` |
| `ANTHROPIC_API_KEY` | If Claude | Anthropic API key |
| `OPENAI_API_KEY` | If Codex | OpenAI API key |
| `GITLAB_TOKEN` | If GitLab | GitLab PAT with `api` scope |
| `GITLAB_PROJECT_ID` | If GitLab | Numeric ID or `group/project` path |
| `GITHUB_TOKEN` | If GitHub | GitHub PAT with `repo` scope |
| `GITHUB_REPO` | If GitHub | `owner/repo` format |
| `REPO_URL` | Yes* | Git clone URL |
| `LOCAL_REPO_PATH` | No | Use a local checkout instead of cloning |
| `LINEAR_API_KEY` | † | Linear API key |
| `LINEAR_CLIENT_ID` | † | Linear OAuth client ID |
| `LINEAR_CLIENT_SECRET` | † | Linear OAuth client secret |
| `WEBHOOK_SECRET` | No | Webhook verification (HMAC for GitHub, token for GitLab) |
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
  │           ├── iptables firewall: only git host, npm, agent API
  │           ├── Non-root user (claude-runner)
  │           ├── 4GB RAM / 2 CPU limit
  │           ├── Ephemeral (destroyed after each task)
  │           └── No Docker socket access
  │
  ├── Bug Fixer Worker (restricted --allowedTools)
  │     └── Can only: read/write files, git, run tests
  │
  └── Webhook Listener
        ├── GitLab: validates X-Gitlab-Token header
        ├── GitHub: validates X-Hub-Signature-256 (HMAC-SHA256)
        └── Only processes comments on auto-fix/* and task/* branches
```

The agent can push to your git host (it needs to for MRs/PRs). Mitigate with: project-scoped tokens, protected branches, and reviewing all MRs/PRs before merging.

## License

MIT
