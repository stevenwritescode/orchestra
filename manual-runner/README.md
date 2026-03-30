# Manual Runner

Spin up a sandboxed agent container to work on any branch with custom instructions. Like the linear-task-runner, but you drive it manually. Supports Claude Code and OpenAI Codex via `AGENT_PROVIDER`.

## Usage

```bash
# Check out an existing branch and give instructions
node run.mjs -b feature/auth -i "Add unit tests for the auth middleware"

# Create a new branch and work on it
node run.mjs -nb fix/login-bug -i "The login button doesn't work on Firefox"

# Use a file for complex instructions
node run.mjs -b main -i "$(cat tasks/refactor-db.md)" --model opus

# Interactive mode — prompts for branch and instructions
node run.mjs --interactive
node run.mjs  # (same — interactive if no args)
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--branch` | `-b` | Existing branch to check out |
| `--new-branch` | `-nb` | Create a new branch from main |
| `--instructions` | `-i` | What to work on |
| `--model` | `-m` | Agent model (default: sonnet) |
| `--interactive` | | Prompt for input |
| `--help` | `-h` | Show help |

## Configuration

Reads from `.env` in this directory, then falls back to `linear-task-runner/.env` for shared config (tokens, repo path, etc.). You only need a separate `.env` here if you want different settings for manual runs.

## Auth

Set `AGENT_PROVIDER` in `.env` to choose your agent:

| Provider | `AGENT_PROVIDER` | Auth |
|----------|-----------------|------|
| Claude Code (default) | `claude` | `ANTHROPIC_API_KEY` or `claude login` |
| OpenAI Codex | `codex` | `OPENAI_API_KEY` or `codex login` |

On macOS, OAuth tokens are read from the system Keychain automatically if no API key is set. On other platforms, the credentials file from the agent's login is used.

## Claude Skills

Set `CLAUDE_SKILLS_DIR` in `.env` to a directory of markdown skill files. Relevant skills are injected into the agent's context automatically based on keyword matching against your instructions.
