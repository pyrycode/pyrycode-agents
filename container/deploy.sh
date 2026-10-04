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
remote 'rm -rf ~/pyrycode-runtime/build && cd ~/pyrycode-runtime 2>/dev/null || mkdir -p ~/pyrycode-runtime; cd ~/pyrycode-runtime && mkdir -p build work home config home-desktop config-desktop'
COPYFILE_DISABLE=1 tar -C "$HERE" --no-xattrs -cf - . | remote 'tar -C ~/pyrycode-runtime/build -xf - 2>/dev/null'
# The pyrycode fork keeps the unsuffixed folders it was first provisioned in.
remote 'install -m 0600 ~/pyrycode-runtime/build/forks/pyrycode.env ~/pyrycode-runtime/config/dispatcher.env
        install -m 0600 ~/pyrycode-runtime/build/forks/pyrycode-desktop.env ~/pyrycode-runtime/config-desktop/dispatcher.env'

echo "Building $IMAGE on $HOST"
remote "podman build --pull=newer -t $IMAGE ~/pyrycode-runtime/build"

echo "Tool check"
remote "podman run --rm --userns=keep-id -v ~/pyrycode-runtime/home:/home/agent $IMAGE check"
