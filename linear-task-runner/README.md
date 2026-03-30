# Linear → Claude Code Task Runner (GitLab Edition)

Autonomous system that pulls tasks from Linear, runs Claude Code in sandboxed Docker containers, implements each task, opens merge requests on GitLab, and updates the Linear issue.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Orchestrator (runs on your server)                      │
│                                                          │
│  1. Polls Linear for issues with label "autofix"         │
│  2. For each task, spawns a fresh Docker container       │
│  3. Container runs Claude Code --dangerously-skip-perms  │
│  4. Claude reads code, implements, tests, opens MR       │
│  5. Orchestrator updates Linear issue with result        │
│  6. Container is destroyed                               │
└──────────────────────────────────────────────────────────┘
```

**Why Docker makes `--dangerously-skip-permissions` safe:**

- Filesystem is isolated (can't touch host files)
- Network is firewalled (can only reach GitLab, npm, Anthropic API)
- Each task gets a fresh container (no state leakage)
- Containers run as non-root
- No access to the host Docker socket
- Resource-limited (4GB RAM, 2 CPUs per task)

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your API keys

# 2. Create the "autofix" label in Linear
#    → Settings → Labels → Create label named "autofix"

# 3. Build and start
docker compose up -d

# 4. Create a test task in Linear
#    → Create an issue, add the "autofix" label
#    → Set status to "Todo"
#    → Add a clear description of what to implement

# 5. Watch the orchestrator
docker compose logs -f orchestrator
```

## Task Lifecycle

| Step | What happens | Linear status |
|------|-------------|---------------|
| 1 | Orchestrator picks up the issue | → In Progress |
| 2 | Docker container spawns with repo clone | In Progress |
| 3 | Claude Code reads codebase, implements task | In Progress |
| 4 | Tests pass, MR opened | → In Review |
| 5 | Tests fail or can't implement | → back to Todo |

## Security Model

```
Host Machine
  └── Orchestrator (has Docker socket access)
        └── Task Container (isolated)
              ├── Firewall: only GitLab, npm, Anthropic API
              ├── User: non-root (claude-runner)
              ├── Filesystem: /workspace only
              ├── No Docker socket access
              ├── Resource-limited (4GB / 2 CPU)
              └── Ephemeral (destroyed after task)
```

**Known trade-off:** The container CAN push to GitLab (it needs to for MRs). Mitigations:
- Use a GitLab token scoped to only your target project
- Use protected branches to prevent pushes to main
- Review all MRs before merging

## Sending Instructions to a Running Container

You can redirect or add context to Claude mid-task without restarting the container.

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

The message is written to `/workspace/signals/inbox.txt` inside the container via `docker exec`. Claude checks this file before each major step, acknowledges the message, and incorporates the instructions before continuing. The file is cleared after reading so each message is only acted on once.

**Note:** The task must have been started with a recent version of orchestra for the container name to be tracked. Older runs won't appear in `--list`.

## GitLab-Specific Details

### Authentication

The container uses `GITLAB_TOKEN` for both:
- **glab CLI**: Configured automatically in `entrypoint.sh` via glab config file
- **Git HTTPS**: Token injected into clone URL as `oauth2:TOKEN@gitlab.com`

### MR Creation

Inside the container, Claude Code uses `glab mr create` to open draft merge requests. The glab CLI reads the `GITLAB_TOKEN` from its config.

### Self-Hosted GitLab

Set `GITLAB_URL` to your instance URL (e.g., `https://gitlab.example.com`). The entrypoint script handles configuring glab for the correct host.
