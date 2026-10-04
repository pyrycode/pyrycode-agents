#!/bin/bash
# Run on the Mac. Copies the dispatcher's three secrets from 1Password's
# Automation vault into Podman secrets on pyrybox, replacing any old value.
#
#   container/push-secrets.sh [path/to/agents/.env]
#
# The GitHub token has its own 1Password item, scoped to this container
# (Automation vault, item "GitHub pyrybox container token"), since it is not
# shared with the Mac dispatchers. The other two op:// references are read
# from the Mac agents repo's .env. Each value travels from `op read` to
# `podman secret create` over stdin only: never as an argument, never in a
# file on the Mac, never on this terminal.
set -euo pipefail

HOST="${PYRY_CONTAINER_HOST:-pyrybox}"
HELPER="${PYRY_AUTOMATION_ACCESS:-$HOME/.local/bin/automation-access}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$HERE/../../pyrycode-agents/.env}"
GITHUB_TOKEN_REF="op://jgeingz3lrrlvqdgtsnyw7yu2e/m2lqgwry3hsyuf5puzz4de4ega/token"

if [ -z "${PYRY_CONTAINER_KEYED:-}" ]; then
  exec "$HELPER" with-pyrybox-key env PYRY_CONTAINER_KEYED=1 "$0" "$@"
fi
remote() { ssh -o IdentityAgent="$SSH_AUTH_SOCK" -o ConnectTimeout=10 "$HOST" "$@"; }

push_ref() {
  local secret="$1" ref="$2"
  case "$ref" in
    op://*) ;;
    *) echo "invalid op:// reference for $secret" >&2; return 1 ;;
  esac
  "$HELPER" op read --no-newline "$ref" \
    | remote "podman secret rm $secret >/dev/null 2>&1 || true; podman secret create $secret - >/dev/null"
  echo "$secret: stored"
}

push() {
  local secret="$1" var="$2" ref
  ref="$(sed -n "s/^$var=//p" "$ENV_FILE" | head -1 | tr -d '"')"
  case "$ref" in
    op://*) ;;
    *) echo "no op:// reference for $var in $ENV_FILE" >&2; return 1 ;;
  esac
  push_ref "$secret" "$ref"
}

push_ref pyrycode-github-token "$GITHUB_TOKEN_REF"
push pyrycode-claude-token CLAUDE_CODE_OAUTH_TOKEN
push pyrycode-discord-webhook DISCORD_WEBHOOK_URL
