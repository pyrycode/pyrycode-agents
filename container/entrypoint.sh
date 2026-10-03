#!/bin/bash
# Entry point of the pyrycode agent runtime container.
#
#   pyry-container check   print tool versions and which secrets are present
#   pyry-container setup   provision repos, logins, Claude config and indexes
#   pyry-container smoke   setup, then prove GitHub and Claude logins work
#   pyry-container run     setup, then start the dispatcher (the default)
#
# Every step is idempotent. Only the indexes are slow, and they are built
# once, then refreshed by the dispatcher before each agent spawn.
set -euo pipefail

WORK_ROOT="${WORK_ROOT:-/work/Projects}"
TARGET="$WORK_ROOT/pyrycode"
AGENTS="$WORK_ROOT/pyrycode-agents"
TARGET_REPO_URL="${TARGET_REPO_URL:-https://github.com/pyrycode/pyrycode.git}"
AGENTS_REPO_URL="${AGENTS_REPO_URL:-https://github.com/pyrycode/pyrycode-agents.git}"
CONFIG_ENV="${CONFIG_ENV:-/config/dispatcher.env}"
CLAUDE_FILES=/opt/pyry-container/claude
INDEX_STAMP="$HOME/.pyry-container-indexes-v1"

log() { echo "[pyry-container] $*" >&2; }

load_config() {
  if [ ! -f "$CONFIG_ENV" ]; then
    log "missing $CONFIG_ENV (mount the config folder at /config)"
    exit 1
  fi
  # Only the git identity is needed here; the dispatcher reads the rest
  # from the copy installed as the agents repo's .env.
  GIT_USER_NAME="$(sed -n 's/^GIT_USER_NAME=//p' "$CONFIG_ENV" | tr -d '"')"
  GIT_USER_EMAIL="$(sed -n 's/^GIT_USER_EMAIL=//p' "$CONFIG_ENV" | tr -d '"')"
}

require_secrets() {
  local missing=0 name
  for name in GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    if [ -z "${!name:-}" ]; then
      log "secret $name is not set"
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 1
}

setup_git() {
  git config --global user.name "${GIT_USER_NAME:?set GIT_USER_NAME in dispatcher.env}"
  git config --global user.email "${GIT_USER_EMAIL:?set GIT_USER_EMAIL in dispatcher.env}"
  git config --global init.defaultBranch main
  # The dispatcher scrubs GITHUB_TOKEN from agent environments, so agents'
  # gh and git push need a stored login. Refresh it from the secret on every
  # start. gh refuses to store a login while the variable is set.
  printf '%s\n' "$GITHUB_TOKEN" \
    | env -u GITHUB_TOKEN -u GH_TOKEN gh auth login --hostname github.com \
        --git-protocol https --insecure-storage --with-token
  env -u GITHUB_TOKEN -u GH_TOKEN gh auth setup-git --hostname github.com
}

setup_repos() {
  mkdir -p "$WORK_ROOT"
  if [ ! -d "$TARGET/.git" ]; then
    log "cloning $TARGET_REPO_URL"
    git clone --quiet "$TARGET_REPO_URL" "$TARGET"
  fi
  if [ ! -d "$AGENTS/.git" ]; then
    log "cloning $AGENTS_REPO_URL"
    git clone --quiet "$AGENTS_REPO_URL" "$AGENTS"
  fi
  # The agents checkout is live: the dispatcher reads role instructions from
  # it. Fast-forward it only when it sits clean on main.
  if [ "$(git -C "$AGENTS" branch --show-current)" = main ] \
     && [ -z "$(git -C "$AGENTS" status --porcelain --untracked-files=no)" ]; then
    git -C "$AGENTS" pull --quiet --ff-only || log "agents repo: fast-forward failed, continuing on current commit"
  else
    log "agents repo is not clean on main; leaving it as it is"
  fi
  git -C "$AGENTS" submodule update --init --quiet
  install -m 0600 "$CONFIG_ENV" "$AGENTS/.env"
}

setup_claude() {
  mkdir -p "$HOME/.claude/hooks"
  install -m 0644 "$CLAUDE_FILES/settings.json" "$HOME/.claude/settings.json"
  install -m 0644 "$CLAUDE_FILES/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
  install -m 0755 "$CLAUDE_FILES/hooks/gh-board-listing-guard.py" "$HOME/.claude/hooks/"
  # The real-claude test suite needs onboarding marked complete.
  if [ ! -f "$HOME/.claude.json" ]; then
    printf '{"hasCompletedOnboarding": true}\n' > "$HOME/.claude.json"
  fi
  # User scope, because worktrees under /work have no parent .mcp.json.
  claude mcp get qmd >/dev/null 2>&1 || claude mcp add --scope user qmd -- qmd mcp
  claude mcp get codegraph >/dev/null 2>&1 || claude mcp add --scope user codegraph -- codegraph serve --mcp
  # context7 comes as a plugin so its tool names match the dispatcher's
  # allowlist. Agents still work without it, so a failure only warns.
  if ! claude plugin list 2>/dev/null | grep -q 'context7@claude-plugins-official'; then
    { claude plugin marketplace add anthropics/claude-plugins-official \
        && claude plugin install context7@claude-plugins-official; } >/dev/null 2>&1 \
      || log "context7 plugin install failed; agents run without context7"
  fi
}

setup_indexes() {
  [ -f "$INDEX_STAMP" ] && return 0
  log "first run: building the qmd and codegraph indexes (slow on this CPU)"
  mkdir -p "$HOME/.config/qmd"
  cat > "$HOME/.config/qmd/index.yml" <<EOF
collections:
  pyrycode-docs:
    path: $TARGET/docs
    pattern: "**/*.md"
  pyrycode-root:
    path: $TARGET
    pattern: "**/*.md"
EOF
  (cd "$TARGET" && qmd update && qmd embed)
  if [ ! -d "$TARGET/.codegraph" ]; then
    (cd "$TARGET" && codegraph init -i)
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$INDEX_STAMP"
}

setup() {
  load_config
  require_secrets
  setup_git
  setup_repos
  setup_claude
  setup_indexes
}

check() {
  local tool
  for tool in "git --version" "go version" "node --version" "pnpm --version" \
              "gh --version" "claude --version" "pyry --version" "qmd --version" \
              "codegraph --version" "staticcheck -version" "perl -e print(\$^V)"; do
    printf '%-20s %s\n' "${tool%% *}" "$($tool 2>&1 | head -1)"
  done
  for tool in GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN DISCORD_WEBHOOK_URL; do
    printf '%-24s %s\n' "$tool" "$([ -n "${!tool:-}" ] && echo set || echo missing)"
  done
}

smoke() {
  setup
  log "GitHub login: $(env -u GITHUB_TOKEN -u GH_TOKEN gh api user -q .login)"
  log "Claude: $(cd /tmp && claude -p 'Reply with the single word OK.' --max-turns 1 2>&1 | tail -1)"
}

case "${1:-run}" in
  check) check ;;
  setup) setup ;;
  smoke) smoke ;;
  run)
    shift || true
    setup
    export TARGET_REPO_PATH="$TARGET"
    exec "$AGENTS/bin/pyry-start" "$@"
    ;;
  *)
    echo "usage: pyry-container [check|setup|smoke|run [dispatcher args...]]" >&2
    exit 2
    ;;
esac
