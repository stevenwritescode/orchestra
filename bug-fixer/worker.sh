#!/bin/bash
# =============================================================================
# Bug Fixer — Worker
#
# Polls the queue for pending bug reports. For each report:
#   1. TRIAGE: Cheap Claude Code call to classify the report
#   2. FIX: Full Claude Code session to find root cause and write a fix
#   3. Opens a draft MR on GitLab via glab CLI or GitLab API
#
# Usage:
#   ANTHROPIC_API_KEY=sk-ant-... GITLAB_TOKEN=glpat-... ./worker.sh
# =============================================================================

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
QUEUE_DIR="${QUEUE_DIR:-./queue}"
REPO_DIR="${REPO_DIR:-./repo}"
POLL_INTERVAL="${POLL_INTERVAL:-10}"
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
MAX_TURNS="${MAX_TURNS:-25}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
GITLAB_URL="${GITLAB_URL:-https://gitlab.com}"
GITLAB_PROJECT_ID="${GITLAB_PROJECT_ID:?GITLAB_PROJECT_ID is required}"

# Local repo: absolute path to a repo already on this machine.
# If set, the worker copies this into REPO_DIR instead of cloning from REPO_URL.
LOCAL_REPO_PATH="${LOCAL_REPO_PATH:-}"

# Backend Docker testing (orchestrator-mediated)
BACKEND_DOCKER_COMPOSE="${BACKEND_DOCKER_COMPOSE:-}"
BACKEND_SERVICE_NAME="${BACKEND_SERVICE_NAME:-backend}"
BACKEND_TEST_CMD="${BACKEND_TEST_CMD:-docker compose run --rm backend npm test}"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-}"
BACKEND_HEALTH_TIMEOUT_MS="${BACKEND_HEALTH_TIMEOUT_MS:-30000}"
MAX_FIX_ITERATIONS="${MAX_FIX_ITERATIONS:-3}"

# Validate required env vars
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${GITLAB_TOKEN:?GITLAB_TOKEN is required}"

if [ -z "$REPO_URL" ] && [ -z "$LOCAL_REPO_PATH" ]; then
    echo "Either REPO_URL or LOCAL_REPO_PATH must be set" >&2
    exit 1
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%S)] $*"; }

# ─── Ensure queue directories exist ─────────────────────────────────────────
mkdir -p "$QUEUE_DIR"/{pending,processing,done,rejected}

# ─── Clone or copy repo ─────────────────────────────────────────────────────
if [ ! -d "$REPO_DIR/.git" ]; then
    if [ -n "$LOCAL_REPO_PATH" ] && [ -d "$LOCAL_REPO_PATH/.git" ]; then
        log "Copying local repo from ${LOCAL_REPO_PATH}..."
        git clone --local "$LOCAL_REPO_PATH" "$REPO_DIR"
        # Point remote back to GitLab for push
        if [ -n "$REPO_URL" ]; then
            git -C "$REPO_DIR" remote set-url origin "$REPO_URL"
        fi
    elif [ -n "$REPO_URL" ]; then
        log "Cloning repo..."
        git clone "$REPO_URL" "$REPO_DIR"
    fi
fi

# ─── Triage a bug report ────────────────────────────────────────────────────
# Uses a single-turn Claude call to classify the report cheaply.
# Returns a JSON classification.
triage_report() {
    local report_file="$1"
    local report
    report=$(cat "$report_file")

    local prompt="You are a bug report triage bot. Classify this report into exactly one category.

Bug Report:
$report

Respond with ONLY a JSON object (no markdown, no explanation):
{
  \"classification\": \"bug\" | \"feature_request\" | \"user_error\" | \"unclear\" | \"duplicate\",
  \"confidence\": 0.0-1.0,
  \"reason\": \"one sentence explanation\"
}

Rules:
- \"bug\": A genuine software defect that needs code changes to fix
- \"feature_request\": Asking for new functionality, not a broken existing feature
- \"user_error\": User is doing something wrong, the software works as designed
- \"unclear\": Not enough information to determine if this is a real bug
- \"duplicate\": Describes a very common/generic issue that is likely already known"

    claude -p "$prompt" \
        --max-turns 1 \
        --model "$CLAUDE_MODEL" \
        --output-format json 2>/dev/null
}

# ─── Fix a bug ──────────────────────────────────────────────────────────────
# Runs Claude Code in the repo to find and fix the bug.
fix_bug() {
    local report_file="$1"
    local report_id="$2"
    local branch_name="auto-fix/${report_id}"
    local report
    report=$(cat "$report_file")

    # Reset repo to target branch
    cd "$REPO_DIR"
    git fetch origin
    git checkout "$TARGET_BRANCH"
    git pull origin "$TARGET_BRANCH"
    git checkout -b "$branch_name"
    cd - > /dev/null

    local prompt="You are an autonomous bug-fixing agent. A bug has been reported and triaged as a genuine bug.

Bug Report:
$report

Instructions:
1. Read the codebase to understand the relevant code and find the root cause
2. Write a minimal, focused fix for the bug
3. Write or update tests to cover the fix if appropriate
4. Run the existing test suite to verify nothing is broken
5. If tests pass, commit your changes with message: \"fix: auto-fix for report ${report_id}\"
6. Push the branch to origin

Important:
- Make the smallest change that fixes the bug
- Do not refactor unrelated code
- If you cannot identify the root cause, explain what you found and stop
- The branch ${branch_name} is already checked out"

    cd "$REPO_DIR"
    claude -p "$prompt" \
        --model "$CLAUDE_MODEL" \
        --max-turns "$MAX_TURNS" \
        --allowedTools "Read" "Edit" "Write" "Glob" "Grep" \
            "Bash(git *)" "Bash(glab *)" \
            "Bash(npm test*)" "Bash(npm run *)" \
            "Bash(npx *)" "Bash(node *)" \
            "Bash(pytest*)" "Bash(python *)" \
            "Bash(cargo test*)" "Bash(go test*)" \
            "Bash(make test*)" \
        --output-format json 2>/dev/null
    local exit_code=$?
    cd - > /dev/null

    return $exit_code
}

# ─── Create a draft MR on GitLab ────────────────────────────────────────────
create_merge_request() {
    local report_id="$1"
    local report_file="$2"
    local branch_name="auto-fix/${report_id}"
    local title description

    title=$(jq -r '.title // "Auto-fix"' "$report_file")
    description=$(jq -r '.description // "No description"' "$report_file")

    local mr_body="## Auto-generated fix

**Report ID:** \`${report_id}\`

**Original report:**
> ${title}
>
> ${description}

---
This merge request was automatically generated by the bug-fixer pipeline.
Please review carefully before merging."

    # Use GitLab API to create a draft merge request
    local response
    response=$(curl -s -w "\n%{http_code}" \
        -X POST "${GITLAB_URL}/api/v4/projects/$(urlencode "$GITLAB_PROJECT_ID")/merge_requests" \
        -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$(jq -n \
            --arg source "$branch_name" \
            --arg target "$TARGET_BRANCH" \
            --arg title "Draft: fix: ${title}" \
            --arg desc "$mr_body" \
            '{
                source_branch: $source,
                target_branch: $target,
                title: $title,
                description: $desc
            }'
        )")

    local http_code
    http_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        local mr_url mr_iid
        mr_url=$(echo "$body" | jq -r '.web_url')
        mr_iid=$(echo "$body" | jq -r '.iid')
        log "MR created: !${mr_iid} — ${mr_url}"
        echo "$mr_url"
    else
        log "Failed to create MR (HTTP ${http_code}): ${body}"
        return 1
    fi
}

# URL-encode a string (for project path in API URLs)
urlencode() {
    python3 -c "import urllib.parse; print(urllib.parse.quote('$1', safe=''))"
}

# ─── Backend Docker testing (orchestrator-mediated) ──────────────────────────
# The worker builds and tests the backend container on the host after the
# agent makes code changes. If tests fail, feeds results back to a new
# Claude session to fix.
run_backend_tests() {
    local report_id="$1"
    local report_file="$2"
    local compose_file="${REPO_DIR}/${BACKEND_DOCKER_COMPOSE}"
    local compose_dir
    compose_dir=$(dirname "$compose_file")

    if [ ! -f "$compose_file" ]; then
        log "[${report_id}] Backend compose file not found: ${compose_file}"
        return 0
    fi

    for iteration in $(seq 1 "$MAX_FIX_ITERATIONS"); do
        log "[${report_id}] Backend test iteration ${iteration}/${MAX_FIX_ITERATIONS}"

        # Build
        local build_ok=true
        docker compose -f "$compose_file" build "$BACKEND_SERVICE_NAME" 2>&1 || build_ok=false

        if [ "$build_ok" = false ]; then
            log "[${report_id}] Backend build failed on iteration ${iteration}"
            if [ "$iteration" -ge "$MAX_FIX_ITERATIONS" ]; then
                log "[${report_id}] Max iterations reached, continuing with push"
                break
            fi
            # Feed build failure back to Claude (below)
        else
            # Start backend
            docker compose -f "$compose_file" up -d "$BACKEND_SERVICE_NAME" 2>&1

            # Wait for health if configured
            if [ -n "$BACKEND_HEALTH_URL" ]; then
                log "[${report_id}] Waiting for health: ${BACKEND_HEALTH_URL}"
                local elapsed=0
                while [ "$elapsed" -lt "$BACKEND_HEALTH_TIMEOUT_MS" ]; do
                    if curl -sf "$BACKEND_HEALTH_URL" > /dev/null 2>&1; then
                        break
                    fi
                    sleep 2
                    elapsed=$((elapsed + 2000))
                done
            fi

            # Run tests
            local test_output test_ok=true
            test_output=$(eval "$BACKEND_TEST_CMD" 2>&1) || test_ok=false

            # Tear down
            docker compose -f "$compose_file" down --remove-orphans 2>/dev/null || true

            if [ "$test_ok" = true ]; then
                log "[${report_id}] Backend tests passed on iteration ${iteration}"
                return 0
            fi

            log "[${report_id}] Backend tests failed on iteration ${iteration}"

            if [ "$iteration" -ge "$MAX_FIX_ITERATIONS" ]; then
                log "[${report_id}] Max iterations reached, continuing with push"
                break
            fi
        fi

        # Feed failure back to Claude for a fix attempt
        local fix_prompt="The backend Docker container was built and tested, but the tests FAILED.

Test output:
\`\`\`
${test_output:-Build failed}
\`\`\`

This is iteration ${iteration} of ${MAX_FIX_ITERATIONS}. Fix the code so the tests pass.
Do NOT try to run docker or docker compose — the orchestrator handles that.
Just fix the code, run any non-Docker tests, and commit."

        cd "$REPO_DIR"
        claude -p "$fix_prompt" \
            --model "$CLAUDE_MODEL" \
            --max-turns "$MAX_TURNS" \
            --allowedTools "Read" "Edit" "Write" "Glob" "Grep" \
                "Bash(git *)" "Bash(glab *)" \
                "Bash(npm test*)" "Bash(npm run *)" \
                "Bash(npx *)" "Bash(node *)" \
                "Bash(pytest*)" "Bash(python *)" \
                "Bash(cargo test*)" "Bash(go test*)" \
                "Bash(make test*)" \
            --output-format json 2>/dev/null || true
        cd - > /dev/null
    done
}

# ─── Process a single report ────────────────────────────────────────────────
process_report() {
    local filename="$1"
    local report_id="${filename%.json}"
    local pending_file="${QUEUE_DIR}/pending/${filename}"
    local processing_file="${QUEUE_DIR}/processing/${filename}"

    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log "Processing report: ${report_id}"

    # Move to processing
    mv "$pending_file" "$processing_file"

    # Stage 1: Triage
    log "[${report_id}] Stage 1: Triage"
    local triage_output triage_result classification confidence

    triage_output=$(triage_report "$processing_file") || true

    # Parse the triage result — extract the JSON from Claude's output
    triage_result=$(echo "$triage_output" | jq -r '.result // empty' 2>/dev/null || echo "$triage_output")
    classification=$(echo "$triage_result" | jq -r '.classification // "unclear"' 2>/dev/null || echo "unclear")
    confidence=$(echo "$triage_result" | jq -r '.confidence // 0' 2>/dev/null || echo "0")

    log "[${report_id}] Classification: ${classification} (confidence: ${confidence})"

    if [ "$classification" != "bug" ]; then
        log "[${report_id}] Not a bug — moving to rejected/"
        # Add triage result to the report
        jq --arg cls "$classification" --arg conf "$confidence" --arg reason "$(echo "$triage_result" | jq -r '.reason // "N/A"' 2>/dev/null)" \
            '. + {triage: {classification: $cls, confidence: ($conf | tonumber), reason: $reason}}' \
            "$processing_file" > "${QUEUE_DIR}/rejected/${filename}"
        rm "$processing_file"
        return 0
    fi

    # Stage 2: Fix
    log "[${report_id}] Stage 2: Attempting fix"
    local fix_output fix_exit_code=0
    fix_output=$(fix_bug "$processing_file" "$report_id") || fix_exit_code=$?

    if [ $fix_exit_code -ne 0 ]; then
        log "[${report_id}] Fix failed (exit code ${fix_exit_code})"
        jq --arg err "Fix failed with exit code ${fix_exit_code}" \
            '. + {fix_error: $err}' \
            "$processing_file" > "${QUEUE_DIR}/rejected/${filename}"
        rm "$processing_file"
        return 1
    fi

    # Check if there are actual commits on the branch
    cd "$REPO_DIR"
    local branch_name="auto-fix/${report_id}"
    local commit_count
    commit_count=$(git log "${TARGET_BRANCH}..${branch_name}" --oneline 2>/dev/null | wc -l | tr -d ' ')
    cd - > /dev/null

    if [ "$commit_count" -eq 0 ]; then
        log "[${report_id}] No commits made — fix was not implemented"
        jq '. + {fix_error: "No commits were made"}' \
            "$processing_file" > "${QUEUE_DIR}/rejected/${filename}"
        rm "$processing_file"
        return 1
    fi

    # Stage 2.5: Backend Docker testing (if configured)
    if [ -n "$BACKEND_DOCKER_COMPOSE" ]; then
        run_backend_tests "$report_id" "$processing_file"
    fi

    # Push the branch
    cd "$REPO_DIR"
    git push origin "$branch_name" 2>/dev/null
    cd - > /dev/null

    # Stage 3: Create MR
    log "[${report_id}] Stage 3: Creating merge request"
    local mr_url
    mr_url=$(create_merge_request "$report_id" "$processing_file") || true

    # Move to done
    jq --arg mr "$mr_url" --arg branch "$branch_name" \
        '. + {merge_request_url: $mr, branch: $branch, completed_at: (now | todate)}' \
        "$processing_file" > "${QUEUE_DIR}/done/${filename}"
    rm "$processing_file"

    log "[${report_id}] Done — MR: ${mr_url:-none}"
}

# ─── Main Loop ──────────────────────────────────────────────────────────────
log "Bug fixer worker started"
log "Queue: ${QUEUE_DIR} | Repo: ${LOCAL_REPO_PATH:-${REPO_URL}} | Poll interval: ${POLL_INTERVAL}s"
log "Model: ${CLAUDE_MODEL} | Max turns: ${MAX_TURNS}"
log "GitLab: ${GITLAB_URL} | Project: ${GITLAB_PROJECT_ID}"
if [ -n "$BACKEND_DOCKER_COMPOSE" ]; then
    log "Backend testing: ${BACKEND_DOCKER_COMPOSE} (service: ${BACKEND_SERVICE_NAME})"
    log "  Test cmd: ${BACKEND_TEST_CMD}"
    log "  Max fix iterations: ${MAX_FIX_ITERATIONS}"
fi

while true; do
    # Find pending reports (oldest first)
    pending_files=$(ls -1t "$QUEUE_DIR/pending/"*.json 2>/dev/null | tail -r || true)

    if [ -n "$pending_files" ]; then
        # Process one at a time
        first_file=$(echo "$pending_files" | head -1)
        filename=$(basename "$first_file")
        process_report "$filename" || log "Error processing ${filename}"
    fi

    sleep "$POLL_INTERVAL"
done
