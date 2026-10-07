#!/bin/bash
# Runs on pyrybox, started by pyrycode-qmd-refresh.timer. Keeps both agent
# containers' qmd indexes current, at the lowest priority the box offers, and
# does nothing while the checkouts they read have not moved.
#
#   pyrycode          index in home/,         reads pyrycode
#   pyrycode-desktop  index in home-desktop/, reads pyrycode-desktop and pyrycode
#
# The dispatchers fast-forward those main checkouts after each merge and
# before each dispatch, so this script only reads them: a second git writer
# there could make a dispatcher's own pull fail and label a ticket with an
# error. Both forks set PYRY_SKIP_QMD_REFRESH=1, so nothing else embeds.
#
# Why not `podman exec` into the dispatcher container: nice only ranks qmd
# against that container's own processes. The other pipeline's gates run in
# a sibling cgroup, and the kernel splits the CPU evenly between the two
# containers before nice applies. So the embedding runs in a short-lived
# container of the dispatcher's own image and home, placed beside the
# dispatchers in pyrycode-agents.slice with CPU weight 1 against their 100
# and at most two CPUs. Inside it, qmd runs under nice 19 and the idle IO
# class, and qmd-embed-threads.mjs caps its embedding threads at two, down
# from the four qmd takes on its own. (The disks use the `none` IO
# scheduler, which ignores IO classes, so ionice is a no-op here today.)
#
# Each run gives each fork at most one `qmd embed` pass, which qmd itself
# stops after 30 minutes. A fork whose pass leaves documents pending keeps
# its old stamp, so the next tick carries on; one fork's backlog delays the
# other by at most one pass. With no dispatcher container running, nothing
# reads that fork's index, so its turn waits for a later tick.
set -uo pipefail

RUNTIME="$HOME/pyrycode-runtime"
WORK="$RUNTIME/work"
PRELOAD=/work/Projects/pyrycode-agents/container/qmd-embed-threads.mjs
THREADS=2
LOCK="$RUNTIME/.qmd-refresh.lock"

exec 9>"$LOCK"
flock -n 9 || { echo "another refresh is running"; exit 0; }

embed_container=""
trap '[ -n "$embed_container" ] && podman stop -t 10 "$embed_container" >/dev/null 2>&1' EXIT

# refresh <fork> <dispatcher container> <home dir> <checkout>...
# The first checkout is the fork's own and becomes the working directory.
refresh() {
  local fork=$1 container=$2 home=$3
  shift 3
  local stamp="$RUNTIME/qmd-indexed-$fork" key="" co
  for co in "$@"; do
    key+="$(git -C "$WORK/Projects/$co" rev-parse --short=12 HEAD) "
  done
  key=${key% }
  [ "$key" = "$(cat "$stamp" 2>/dev/null)" ] && return 0

  if [ "$(podman container inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != true ]; then
    echo "$fork: $container is not running; will retry"
    return 0
  fi
  local image
  image=$(podman container inspect -f '{{.Image}}' "$container") || return 0
  embed_container="pyrycode-qmd-embed-$fork"
  if podman container exists "$embed_container"; then
    echo "$fork: $embed_container from an earlier run is still going; will retry"
    embed_container=""
    return 0
  fi

  echo "$fork: checkouts at $key, last complete at $(cat "$stamp" 2>/dev/null || echo never)"
  local start=$SECONDS out
  out=$(podman run --rm --name "$embed_container" --init --userns=keep-id \
      --cgroup-parent=pyrycode-agents.slice --cpu-shares=2 --cpus=2 --memory=2g \
      -v "$WORK:/work" -v "$home:/home/agent" -w "/work/Projects/$1" \
      -e "PRELOAD=$PRELOAD" -e "THREADS=$THREADS" \
      --entrypoint bash "$image" -c '
    pending() { qmd status 2>/dev/null | sed -n "s/.*Pending: *\([0-9]*\).*/\1/p" | grep . || echo 0; }
    nice -n 19 ionice -c3 qmd update >/dev/null || { echo "update failed"; exit 1; }
    before=$(pending)
    echo "before $before"
    [ "$before" = 0 ] && exit 0
    TIMEFORMAT="cpu %U %S"
    { time NODE_OPTIONS="--import=$PRELOAD" QMD_EMBED_THREADS=$THREADS \
        nice -n 19 ionice -c3 qmd embed >/dev/null 2>&1; } 2>&1
    echo "after $(pending)"' 2>&1)
  local rc=$?
  embed_container=""
  local before after cpu
  before=$(sed -n 's/^before //p' <<<"$out")
  after=$(sed -n 's/^after //p' <<<"$out")
  after=${after:-$before}
  cpu=$(awk '/^cpu /{printf ", embed used %d CPU-seconds", $2 + $3}' <<<"$out")
  if [ $rc -ne 0 ] || [ -z "$before" ]; then
    echo "$fork: refresh failed (exit $rc): $(tail -3 <<<"$out" | tr '\n' ' ')"
    return 0
  fi
  echo "$fork: $before pending, $after left after $(( (SECONDS - start) / 60 ))m $(( (SECONDS - start) % 60 ))s$cpu"
  if [ "$after" = 0 ]; then
    echo "$key" > "$stamp"
  elif [ "$after" = "$before" ]; then
    # A pass that finished nothing would only repeat itself every tick.
    echo "$fork: no progress; waiting for the next change"
    echo "$key" > "$stamp"
  fi
}

refresh pyrycode pyrycode-dispatcher "$RUNTIME/home" pyrycode
refresh pyrycode-desktop pyrycode-desktop-dispatcher "$RUNTIME/home-desktop" pyrycode-desktop pyrycode
