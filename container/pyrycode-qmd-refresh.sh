#!/bin/bash
# Runs on pyrybox, started by pyrycode-qmd-refresh.timer. Refreshes the
# pyrycode container's shared qmd index once each time pyrycode main moves
# on, and does nothing otherwise.
#
# The index lives in the container's home and reads the main checkout at
# /work/Projects/pyrycode. The dispatcher fast-forwards that checkout after
# each merge and before each dispatch, so this script only reads it: a
# second git writer there could make the dispatcher's own pull fail and
# label a ticket with an error. The work runs inside the dispatcher
# container, so it uses the same qmd and home and stays within the
# container's CPU and memory caps. With no container running, nothing
# reads the index, so the run waits for the next tick.
set -euo pipefail

CONTAINER=pyrycode-dispatcher
CHECKOUT="$HOME/pyrycode-runtime/work/Projects/pyrycode"
STAMP="$HOME/pyrycode-runtime/qmd-indexed-commit"
LOCK="$HOME/pyrycode-runtime/.qmd-refresh.lock"

exec 9>"$LOCK"
flock -n 9 || { echo "another refresh is running"; exit 0; }

head="$(git -C "$CHECKOUT" rev-parse HEAD)"
[ "$head" = "$(cat "$STAMP" 2>/dev/null)" ] && exit 0

if [ "$(podman container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
  echo "$CONTAINER is not running; will retry"
  exit 0
fi

echo "main is at ${head:0:8}, last indexed $(cut -c1-8 "$STAMP" 2>/dev/null || echo never); reindexing"
# qmd embed stops itself after 30 minutes on this CPU, so repeat it until
# nothing is pending, as nightly-desktop-prep does. Whatever is still
# pending after four rounds is left to the dispatcher's per-spawn embed.
podman exec -w /work/Projects/pyrycode "$CONTAINER" bash -c '
  qmd update >/dev/null || exit 1
  for i in 1 2 3 4; do
    p=$(qmd status 2>/dev/null | sed -n "s/.*Pending: *\([0-9]*\).*/\1/p"); p=${p:-0}
    echo "round $i: $p pending"
    [ "$p" = 0 ] && exit 0
    qmd embed >/dev/null 2>&1 || true
  done'
echo "$head" > "$STAMP"
echo "indexed ${head:0:8}"
