#!/bin/bash
# Run on the Mac. Copies this folder to pyrybox, builds the image there with
# rootless Podman, and prints the tool check. Starts no dispatcher.
#
#   container/deploy.sh
#
# Re-runs itself under the Automation helper, which lends the pyrybox SSH
# key through a temporary agent.
set -euo pipefail

HOST="${PYRY_CONTAINER_HOST:-pyrybox}"
HELPER="${PYRY_AUTOMATION_ACCESS:-$HOME/.local/bin/automation-access}"
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE=localhost/pyrycode-agent-runtime:latest

if [ -z "${PYRY_CONTAINER_KEYED:-}" ]; then
  exec "$HELPER" with-pyrybox-key env PYRY_CONTAINER_KEYED=1 "$0" "$@"
fi
remote() { ssh -o IdentityAgent="$SSH_AUTH_SOCK" -o ConnectTimeout=10 "$HOST" "$@"; }

echo "Copying the build context to $HOST:~/pyrycode-runtime/build"
remote 'rm -rf ~/pyrycode-runtime/build && mkdir -p ~/pyrycode-runtime/build ~/pyrycode-runtime/work ~/pyrycode-runtime/home ~/pyrycode-runtime/config'
COPYFILE_DISABLE=1 tar -C "$HERE" --no-xattrs -cf - . | remote 'tar -C ~/pyrycode-runtime/build -xf - 2>/dev/null'
remote 'install -m 0600 ~/pyrycode-runtime/build/dispatcher.env ~/pyrycode-runtime/config/dispatcher.env'

echo "Building $IMAGE on $HOST"
remote "podman build --pull=newer -t $IMAGE ~/pyrycode-runtime/build"

echo "Tool check"
remote "podman run --rm --userns=keep-id -v ~/pyrycode-runtime/home:/home/agent $IMAGE check"
