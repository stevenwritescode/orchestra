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

# Claude Code CLI is installed at container start (in entrypoint.sh)
# so that CUSTOM_CA_CERT from the mounted repo is available for npm.

# Install glab CLI (GitLab CLI)
# Fetch latest version tag from GitLab API, then download the .deb from the
# generic packages registry (the old permalink URL scheme no longer works).
RUN ARCH=$(dpkg --print-architecture) \
    && GLAB_VERSION=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases" | jq -r '.[0].tag_name' | sed 's/^v//') \
    && curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${GLAB_VERSION}/glab_${GLAB_VERSION}_linux_${ARCH}.deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb

# Install gh CLI (GitHub CLI)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update -qq && apt-get install -y -qq gh \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for Claude Code
RUN useradd -m -s /bin/bash claude-runner

# Setup firewall script (runs as root before dropping privileges)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
