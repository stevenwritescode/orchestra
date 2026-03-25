#!/bin/bash
# =============================================================================
# Entrypoint: sets up network firewall, then drops privileges and runs Claude
#
# Firewall strategy:
#   - Allow DNS (needed for all outbound)
#   - Allow HTTPS to: Anthropic API, GitLab, npm registry
#   - If BACKEND_PORT is set: allow traffic to Docker host gateway on that port
#   - Block everything else
#
# This prevents Claude Code from exfiltrating data to arbitrary hosts
# even with --dangerously-skip-permissions enabled.
# =============================================================================

set -e

# ─── Resolve Docker host gateway IP ─────────────────────────────────────────
# The agent needs to reach the backend container running on the host.
# Docker provides host.docker.internal on Docker Desktop, but on Linux
# we need to find the gateway IP from the container's routing table.
get_host_gateway_ip() {
    # Try host.docker.internal first (Docker Desktop for Mac/Windows)
    local ip
    ip=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
    if [ -n "$ip" ]; then
        echo "$ip"
        return
    fi
    # Fall back to default gateway (Linux Docker)
    ip route | awk '/default/ { print $3 }' | head -1
}

# ─── Setup firewall (requires NET_ADMIN capability) ─────────────────────────
setup_firewall() {
    echo "[entrypoint] Setting up firewall rules..."

    # Flush existing rules
    iptables -F OUTPUT 2>/dev/null || true

    # Allow loopback
    iptables -A OUTPUT -o lo -j ACCEPT

    # Allow DNS (UDP 53) — needed for hostname resolution
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

    # Allow HTTPS (443) — covers GitLab, npm registry, Anthropic API
    # For stricter control, resolve and whitelist specific IPs or use a proxy
    iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT

    # Allow SSH (22) for git operations
    iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT

    # Allow HTTP (80) for package registries that redirect
    iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT

    # ── Backend access: allow agent to reach the backend on the host ─────
    # BACKEND_PORT can be a single port "3000" or comma-separated "3000,5432"
    if [ -n "${BACKEND_PORT:-}" ]; then
        HOST_GW=$(get_host_gateway_ip)
        if [ -n "$HOST_GW" ]; then
            IFS=',' read -ra PORTS <<< "$BACKEND_PORT"
            for port in "${PORTS[@]}"; do
                port=$(echo "$port" | tr -d ' ')
                iptables -A OUTPUT -p tcp -d "$HOST_GW" --dport "$port" -j ACCEPT
                echo "[entrypoint] Allowing backend access: ${HOST_GW}:${port}"
            done
        else
            echo "[entrypoint] WARNING: Could not determine host gateway IP for backend access"
        fi
    fi

    # Allow established/related connections
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

    # Drop everything else
    iptables -A OUTPUT -j DROP

    echo "[entrypoint] Firewall configured."
}

# Only set up firewall if we have the capability
if iptables -L OUTPUT -n &>/dev/null; then
    setup_firewall
else
    echo "[entrypoint] No NET_ADMIN capability — skipping firewall setup."
    echo "[entrypoint] For maximum security, run with --cap-add=NET_ADMIN"
fi

# ─── Install custom CA cert (e.g. Zscaler) ───────────────────────────────────
# CUSTOM_CA_CERT can be an absolute path or relative to /workspace/repo.
# Set it only on networks that do SSL inspection. Leave empty otherwise.
if [ -n "${CUSTOM_CA_CERT:-}" ]; then
    CERT_PATH="$CUSTOM_CA_CERT"
    # If relative, resolve against the repo
    if [[ "$CERT_PATH" != /* ]]; then
        CERT_PATH="/workspace/repo/${CERT_PATH}"
    fi
    if [ -f "$CERT_PATH" ]; then
        cp "$CERT_PATH" /usr/local/share/ca-certificates/custom-ca.crt
        update-ca-certificates 2>/dev/null
        export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/custom-ca.crt
        echo "[entrypoint] Custom CA cert installed from ${CERT_PATH}"
    else
        echo "[entrypoint] WARNING: CUSTOM_CA_CERT set but file not found: ${CERT_PATH}"
    fi
fi

# ─── Setup git config ───────────────────────────────────────────────────────
git config --global user.name "claude-task-runner"
git config --global user.email "claude-task-runner@automated"
git config --global init.defaultBranch main

# ─── Authenticate git provider CLI ─────────────────────────────────────────
GIT_PROVIDER="${GIT_PROVIDER:-gitlab}"

if [ "$GIT_PROVIDER" = "github" ]; then
    if [ -n "$GITHUB_TOKEN" ]; then
        export GH_TOKEN="$GITHUB_TOKEN"

        GITHUB_HOST="${GITHUB_URL:-https://github.com}"
        GITHUB_HOST="${GITHUB_HOST#https://}"
        GITHUB_HOST="${GITHUB_HOST#http://}"

        # Configure gh CLI
        mkdir -p /home/claude-runner/.config/gh
        cat > /home/claude-runner/.config/gh/hosts.yml <<GHEOF
${GITHUB_HOST}:
    oauth_token: ${GITHUB_TOKEN}
    git_protocol: https
GHEOF
        chown -R claude-runner:claude-runner /home/claude-runner/.config

        echo "[entrypoint] gh CLI configured for ${GITHUB_HOST}."
    fi
else
    if [ -n "$GITLAB_TOKEN" ]; then
        # glab uses GITLAB_TOKEN env var directly for authentication.
        # Set the default host for glab CLI.
        GITLAB_HOST="${GITLAB_URL:-https://gitlab.com}"
        GITLAB_HOST="${GITLAB_HOST#https://}"
        GITLAB_HOST="${GITLAB_HOST#http://}"

        # Configure glab to use the token
        mkdir -p /home/claude-runner/.config/glab-cli
        cat > /home/claude-runner/.config/glab-cli/config.yml <<GLABEOF
hosts:
  ${GITLAB_HOST}:
    token: ${GITLAB_TOKEN}
    api_host: ${GITLAB_HOST}
    git_protocol: https
GLABEOF
        chown -R claude-runner:claude-runner /home/claude-runner/.config

        echo "[entrypoint] glab CLI configured for ${GITLAB_HOST}."
    fi
fi

# ─── Clone repo if not already present ───────────────────────────────────────
# Build authenticated URL based on git provider
get_authed_url() {
    local url="$1"
    if [ "$GIT_PROVIDER" = "github" ] && [ -n "$GITHUB_TOKEN" ]; then
        echo "$url" | sed "s|https://|https://${GITHUB_TOKEN}@|"
    elif [ "$GIT_PROVIDER" = "gitlab" ] && [ -n "$GITLAB_TOKEN" ]; then
        echo "$url" | sed "s|https://|https://oauth2:${GITLAB_TOKEN}@|"
    else
        echo "$url"
    fi
}

if [ "${SKIP_CLONE:-0}" = "1" ] && [ -d "/workspace/repo/.git" ]; then
    echo "[entrypoint] Using bind-mounted repo (SKIP_CLONE=1)."

    # Configure the remote to use authenticated URL for push
    if [ -n "$REPO_URL" ] && [[ "$REPO_URL" == https://* ]]; then
        AUTHED_URL=$(get_authed_url "$REPO_URL")
        if [ "$AUTHED_URL" != "$REPO_URL" ]; then
            git -C /workspace/repo remote set-url origin "$AUTHED_URL" 2>/dev/null || true
        fi
    fi
elif [ -n "$REPO_URL" ] && [ ! -d "/workspace/repo/.git" ]; then
    # Inject token into clone URL for HTTPS auth
    if [[ "$REPO_URL" == https://* ]]; then
        AUTHED_URL=$(get_authed_url "$REPO_URL")
        git clone "$AUTHED_URL" /workspace/repo
    else
        git clone "$REPO_URL" /workspace/repo
    fi
    echo "[entrypoint] Repository cloned."
fi

# ─── Setup signals directory for orchestrator communication ──────────────────
mkdir -p /workspace/signals
echo "[entrypoint] Signals directory ready at /workspace/signals"

# ─── Write backend URL hint for the agent ────────────────────────────────────
if [ -n "${BACKEND_PORT:-}" ]; then
    HOST_GW=$(get_host_gateway_ip)
    # Extract first port for the primary URL
    PRIMARY_PORT=$(echo "$BACKEND_PORT" | cut -d',' -f1 | tr -d ' ')
    echo "http://${HOST_GW}:${PRIMARY_PORT}" > /workspace/signals/backend-url
    echo "[entrypoint] Backend URL: http://${HOST_GW}:${PRIMARY_PORT}"
fi

# ─── Set ownership for non-root user ────────────────────────────────────────
chown -R claude-runner:claude-runner /workspace

# ─── Drop to non-root and execute command ────────────────────────────────────
CA_ENV=""
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
    CA_ENV="NODE_EXTRA_CA_CERTS='${NODE_EXTRA_CA_CERTS}'"
fi

if [ "$GIT_PROVIDER" = "github" ]; then
    exec su - claude-runner -c "cd /workspace/repo && ${CA_ENV} ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}' GITHUB_TOKEN='${GITHUB_TOKEN}' GH_TOKEN='${GITHUB_TOKEN}' $*"
else
    exec su - claude-runner -c "cd /workspace/repo && ${CA_ENV} ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}' GITLAB_TOKEN='${GITLAB_TOKEN}' $*"
fi
