# Linear Task Runner

Autonomous system that polls Linear for tasks, runs an AI agent (Claude Code or Codex) in a sandboxed Docker container, implements each task, opens a merge request on GitLab or pull request on GitHub, and updates the Linear issue.

Set `GIT_PROVIDER=github` or `GIT_PROVIDER=gitlab` and `AGENT_PROVIDER=claude` or `AGENT_PROVIDER=codex` — everything else adapts automatically.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Orchestrator (runs on your server)                      │
│                                                          │
│  1. Polls Linear for issues with label "autofix"         │
│  2. For each task, spawns a fresh Docker container       │
│  3. Container runs the agent with --dangerously-skip-    │
│     permissions (safe inside Docker — see below)         │
│  4. Agent reads code, implements, tests, opens MR/PR     │
│  5. Orchestrator updates Linear issue with result        │
│  6. Container is destroyed                               │
└──────────────────────────────────────────────────────────┘
```

**Why Docker makes `--dangerously-skip-permissions` safe:**

- Filesystem is isolated (can't touch host files)
- Network is firewalled (can only reach git host, npm, agent API)
- Each task gets a fresh container (no state leakage)
- Containers run as non-root
- No access to the host Docker socket
- Resource-limited (4GB RAM, 2 CPUs per task)

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your API keys, GIT_PROVIDER, AGENT_PROVIDER, etc.

# 2. Create the "autofix" label in Linear
#    → Settings → Labels → Create label named "autofix"

# 3. Build and start
docker compose up -d

# 4. Create a test task in Linear
#    → Create an issue, add the "autofix" label
#    → Set status to "Backlog" (or whatever LINEAR_STATUS is set to)
#    → Add a clear description of what to implement

# 5. Watch the orchestrator
docker compose logs -f orchestrator
```

## Task Lifecycle

| Step | What happens | Linear status |
|------|-------------|---------------|
| 1 | Orchestrator picks up the issue | → In Progress |
| 2 | Docker container spawns with repo | In Progress |
| 3 | Agent reads codebase, implements task | In Progress |
| 4 | Tests pass, MR/PR opened | → In Review |
| 5 | Tests fail or can't implement | → back to Todo |
| 6 | Review comments posted | Agent revises + pushes |

## Agent Providers

| Provider | `AGENT_PROVIDER` | Auth |
|----------|-----------------|------|
| Claude Code (default) | `claude` | `ANTHROPIC_API_KEY` or `claude login` |
| OpenAI Codex | `codex` | `OPENAI_API_KEY` or `codex login` |

## Security Model

```
Host Machine
  └── Orchestrator (has Docker socket access)
        └── Task Container (isolated)
              ├── Firewall: only git host, npm, agent API
              ├── User: non-root (claude-runner)
              ├── Filesystem: /workspace only
              ├── No Docker socket access
              ├── Resource-limited (4GB / 2 CPU)
              └── Ephemeral (destroyed after task)
```

**Known trade-off:** The container CAN push to your git host (it needs to for MRs/PRs). Mitigations:
- Use a token scoped to only your target project
- Use protected branches to prevent pushes to main
- Review all MRs/PRs before merging

## Sending Instructions to a Running Container

You can redirect or add context to the agent mid-task without restarting the container.

### List active tasks

```bash
node send.mjs --list
# Active tasks:
#   F2-46  container: task-f2-46-a1b2c3d4  started: 2026-03-30T14:22:00.000Z
#   F2-45  container: task-f2-45-e5f6g7h8  started: 2026-03-30T14:23:00.000Z
```

### Send a message

```bash
node send.mjs <task-id> "<message>"
```

Examples:

```bash
# Redirect focus
node send.mjs F2-46 "Skip the migration for now, handle it in a follow-up ticket"

# Add context
node send.mjs F2-46 "The billing API changed last week — use BillingClientV2 not BillingClient"

# Inject a file
node send.mjs F2-46 "$(cat extra-context.md)"
```

The message is written to `/workspace/signals/inbox.txt` inside the container via `docker exec`. The agent checks this file before each major step, acknowledges the message, and incorporates the instructions before continuing. The file is cleared after reading so each message is only acted on once.

**Note:** The task must have been started with a recent version of orchestra for the container name to be tracked. Older runs won't appear in `--list`.

## Claude Skills

You can provide a directory of markdown skill files that the agent loads as context. Set `CLAUDE_SKILLS_DIR` in `.env` to an absolute path:

```env
CLAUDE_SKILLS_DIR=/path/to/your/skills
```

The orchestrator mounts the directory into each container and tells the agent which skill files are relevant to each task based on keyword matching.

## GitLab-Specific Details

### Authentication

The container uses `GITLAB_TOKEN` for both:
- **glab CLI**: Configured automatically in `entrypoint.sh`
- **Git HTTPS**: Token injected into clone URL as `oauth2:TOKEN@gitlab.com`

### MR Creation

The agent uses `glab mr create` to open draft merge requests. If the agent exits without creating one (e.g. ran out of turns), the orchestrator creates it automatically via the GitLab API.

### Self-Hosted GitLab

Set `GITLAB_URL` to your instance URL (e.g., `https://gitlab.example.com`).

## GitHub-Specific Details

### Authentication

The container uses `GITHUB_TOKEN` for both:
- **gh CLI**: Configured automatically in `entrypoint.sh`
- **Git HTTPS**: Token injected into clone URL

### PR Creation

The agent uses `gh pr create` to open draft pull requests. If the agent exits without creating one, the orchestrator creates it automatically via the GitHub API.
