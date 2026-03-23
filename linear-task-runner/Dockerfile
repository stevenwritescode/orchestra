# =============================================================================
# Sandboxed Claude Code Runner (GitLab Edition)
#
# This container runs Claude Code with --dangerously-skip-permissions safely.
# Security layers:
#   1. Docker isolation (filesystem, process, network)
#   2. Firewall whitelist (only API, GitLab, npm — no arbitrary outbound)
#   3. Non-root user for Claude Code execution
#   4. Ephemeral — destroyed after each task
#   5. No access to host Docker socket
# =============================================================================

FROM node:22-slim

# Install system dependencies
RUN apt-get update -qq && apt-get install -y -qq \
    git \
    jq \
    curl \
    iptables \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install glab CLI (GitLab CLI)
# Fetch latest version tag from GitLab API, then download the .deb from the
# generic packages registry (the old permalink URL scheme no longer works).
RUN ARCH=$(dpkg --print-architecture) \
    && GLAB_VERSION=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases" | jq -r '.[0].tag_name' | sed 's/^v//') \
    && curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${GLAB_VERSION}/glab_${GLAB_VERSION}_linux_${ARCH}.deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb

# Create non-root user for Claude Code
RUN useradd -m -s /bin/bash claude-runner

# Setup firewall script (runs as root before dropping privileges)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
