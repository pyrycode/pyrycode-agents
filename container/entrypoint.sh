#!/bin/bash
# Entry point of the pyrycode agent runtime container.
#
#   pyry-container check   print tool versions and which secrets are present
#   pyry-container setup   provision repos, logins, Claude config and indexes
#   pyry-container smoke   setup, then prove GitHub and Claude logins work
#   pyry-container codex-login  one-time ChatGPT device login for Codex
#   pyry-container run     setup, then start the dispatcher (the default)
#
# Every step is idempotent. Only the indexes are slow, and they are built
# once, then refreshed by the dispatcher before each agent spawn.
#
# FORK selects the pipeline: pyrycode (default, board 1) or
# pyrycode-desktop (board 7). Both forks share /work, so the desktop
# container can index pyrycode's docs; each fork has its own HOME volume.
set -euo pipefail

FORK="${FORK:-pyrycode}"
WORK_ROOT="${WORK_ROOT:-/work/Projects}"
TARGET="$WORK_ROOT/$FORK"
AGENTS="$WORK_ROOT/$FORK-agents"
TARGET_REPO_URL="${TARGET_REPO_URL:-https://github.com/pyrycode/$FORK.git}"
AGENTS_REPO_URL="${AGENTS_REPO_URL:-https://github.com/pyrycode/$FORK-agents.git}"
CONFIG_ENV="${CONFIG_ENV:-/config/dispatcher.env}"
CLAUDE_FILES=/opt/pyry-container/claude
CODEX_FILES=/opt/pyry-container/codex
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
  # The dispatcher scrubs GITHUB_TOKEN from agent environments but passes
  # GH_TOKEN through, and gh prefers GH_TOKEN. So agents' gh, and git push
  # through gh's credential helper, use the same token with no login stored
  # on disk. (`gh auth login --with-token` refuses this token: it lacks the
  # read:org scope that login validation demands.)
  export GH_TOKEN="$GITHUB_TOKEN"
  git config --global credential.https://github.com.helper ''
  git config --global --add credential.https://github.com.helper '!gh auth git-credential'
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
  if [ "$FORK" = pyrycode-desktop ]; then
    # Desktop UI tickets need Figma. It still needs a one-time interactive
    # OAuth login before its tools work.
    jq '.enabledPlugins["figma@claude-plugins-official"] = true' "$HOME/.claude/settings.json" \
      > "$HOME/.claude/settings.json.tmp" && mv "$HOME/.claude/settings.json.tmp" "$HOME/.claude/settings.json"
  fi
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
  local plugins=context7 plugin
  [ "$FORK" = pyrycode-desktop ] && plugins="context7 figma"
  for plugin in $plugins; do
    if ! claude plugin list 2>/dev/null | grep -q "$plugin@claude-plugins-official"; then
      { claude plugin marketplace list 2>/dev/null | grep -q claude-plugins-official \
          || claude plugin marketplace add anthropics/claude-plugins-official; } >/dev/null 2>&1
      claude plugin install "$plugin@claude-plugins-official" >/dev/null 2>&1 \
        || log "$plugin plugin install failed; agents run without $plugin"
    fi
  done
}

setup_codex() {
  # Codex keeps its ChatGPT login in ~/.codex/auth.json, made once with
  # `pyry-container codex-login`. Settings are rewritten on every start.
  mkdir -p "$HOME/.codex"
  install -m 0600 "$CODEX_FILES/config.toml" "$HOME/.codex/config.toml"
  install -m 0644 "$CLAUDE_FILES/CLAUDE.md" "$HOME/.codex/AGENTS.md"
}

setup_indexes() {
  [ -f "$INDEX_STAMP" ] && return 0
  log "first run: building the qmd and codegraph indexes (slow on this CPU)"
  mkdir -p "$HOME/.config/qmd"
  write_qmd_config > "$HOME/.config/qmd/index.yml"
  # qmd embed stops itself after a session limit on this CPU; the
  # dispatcher's per-spawn `qmd embed` finishes whatever is left.
  (cd "$TARGET" && qmd update && qmd embed) || log "qmd embed incomplete; continuing"
  # Some repos track .codegraph/config.json, so test for the database.
  if [ ! -f "$TARGET/.codegraph/codegraph.db" ]; then
    if [ -d "$TARGET/.codegraph" ]; then
      (cd "$TARGET" && codegraph index)
    else
      (cd "$TARGET" && codegraph init -i)
    fi
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$INDEX_STAMP"
}

write_qmd_config() {
  case "$FORK" in
    pyrycode)
      cat <<EOF
collections:
  pyrycode-docs:
    path: $TARGET/docs
    pattern: "**/*.md"
  pyrycode-root:
    path: $TARGET
    pattern: "**/*.md"
EOF
      ;;
    pyrycode-desktop)
      # Desktop roles also search pyrycode-docs for cross-project lessons.
      # Read the shared checkout the pyrycode container keeps; clone it
      # only if that container has never run.
      local core="$WORK_ROOT/pyrycode"
      [ -d "$core/.git" ] || git clone --quiet https://github.com/pyrycode/pyrycode.git "$core"
      cat <<EOF
collections:
  pyrycode-desktop-docs:
    path: $TARGET/docs
    pattern: "**/*.md"
    context:
      "": "Pyrycode Desktop documentation: package overviews under features/, architecture specs, ADRs, and the frozen per-ticket notes under codebase/"
  pyrycode-docs:
    path: $core/docs
    pattern: "**/*.md"
EOF
      ;;
    *) log "no qmd collections defined for FORK=$FORK"; exit 1 ;;
  esac
}

start_display() {
  # Electron needs an X display even with hidden windows. Gates and agents
  # inherit DISPLAY from the dispatcher.
  [ "$FORK" = pyrycode-desktop ] || return 0
  export DISPLAY="${DISPLAY:-:99}"
  if [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
    Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
      sleep 0.5
    done
  fi
}

setup() {
  load_config
  require_secrets
  setup_git
  setup_repos
  setup_claude
  setup_codex
  setup_indexes
}

check() {
  local tool
  for tool in "git --version" "go version" "node --version" "pnpm --version" \
              "gh --version" "claude --version" "pyry --version" "qmd --version" \
              "codegraph --version" "codex --version" "staticcheck -version" "perl -e print(\$^V)"; do
    printf '%-20s %s\n' "${tool%% *}" "$($tool 2>&1 | head -1)"
  done
  for tool in GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN DISCORD_WEBHOOK_URL; do
    printf '%-24s %s\n' "$tool" "$([ -n "${!tool:-}" ] && echo set || echo missing)"
  done
}

smoke() {
  setup
  log "GitHub login: $(env -u GITHUB_TOKEN gh api user -q .login)"
  log "GitHub push access: $(env -u GITHUB_TOKEN git -C "$TARGET" push --dry-run origin HEAD:refs/heads/container-smoke-test 2>&1 | tail -1)"
  log "Claude: $(cd /tmp && claude -p 'Reply with the single word OK.' --max-turns 1 2>&1 | tail -1)"
  log "Codex login: $(codex login status 2>&1 | tail -1)"
}

case "${1:-run}" in
  check) check ;;
  setup) setup ;;
  smoke) smoke ;;
  shell)
    # Debugging aid: a shell with the fork's display running.
    shift || true
    start_display
    exec bash "$@"
    ;;
  codex-login)
    setup_codex
    codex login --device-auth
    ;;
  run)
    shift || true
    setup
    start_display
    export TARGET_REPO_PATH="$TARGET"
    exec "$AGENTS/bin/pyry-start" "$@"
    ;;
  *)
    echo "usage: pyry-container [check|setup|smoke|codex-login|run [dispatcher args...]]" >&2
    exit 2
    ;;
esac
