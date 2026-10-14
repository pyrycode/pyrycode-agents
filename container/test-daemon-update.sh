#!/usr/bin/env bash
# Install the pyry daemon that the agent containers' live tests use.
#
# The folder ~/pyrycode-runtime/test-daemon is mounted read-only at
# /opt/pyry-test-daemon in every agent container. Its `pyry` entry is a
# symbolic link: to versions/<X.Y.Z>/pyry for a release, or to
# /usr/local/bin/pyry, which resolves inside the container to the image's
# own copy. A new release therefore needs only this script, with no image
# rebuild and no container restart.
#
# Usage:
#   test-daemon-update.sh vX.Y.Z [--all]   install that release
#   test-daemon-update.sh latest [--all]   install the latest release
#   test-daemon-update.sh image  [--all]   fall back to the image's copy
#   test-daemon-update.sh status [--all]   print what is installed
#
# --all runs the same command here and then on build-hp-1 and
# build-fractal-2 over ssh. Each machine downloads and verifies on its own.
#
# Verification matches `pyry update`: checksums.txt must carry a valid
# Ed25519 signature from the release signing key, and the tarball must match
# its SHA-256 line in checksums.txt. The key below is the one baked into
# cmd/pyry/update.go (releaseSigningPublicKeyHex). If the release key is ever
# rotated, change it here in the same step, or every install fails closed.
#
# The swap is a rename of the link, so a test that already started keeps the
# binary it started with, and a new start sees either the old or the new
# version, never a partial file.
set -euo pipefail

SIGNING_KEY_HEX=c1839980c8be806616a2761058692426a33f15999b7021d04627d3b99616d282
REPO=pyrycode/pyrycode
HOSTS=(build-hp-1 build-fractal-2)
DIR="${TEST_DAEMON_DIR:-$HOME/pyrycode-runtime/test-daemon}"
KEEP=3

die() { echo "test-daemon: $*" >&2; exit 1; }

usage() { echo "usage: test-daemon-update.sh vX.Y.Z|latest|image|status [--all]" >&2; exit 2; }

[ $# -ge 1 ] || usage
cmd="$1"; shift
all=0
for a in "$@"; do
  case "$a" in --all) all=1 ;; *) usage ;; esac
done

if [ "$all" = 1 ]; then
  self="$(readlink -f "$0")"
  echo "== $(hostname)"
  "$self" "$cmd"
  for h in "${HOSTS[@]}"; do
    echo "== $h"
    ssh -o BatchMode=yes "$h" bash -s -- "$cmd" < "$self"
  done
  exit 0
fi

status() {
  local target version
  target="$(readlink "$DIR/pyry" 2>/dev/null || echo missing)"
  version="$(cat "$DIR/VERSION" 2>/dev/null || echo missing)"
  echo "$(hostname): VERSION=$version pyry -> $target"
}

mkdir -p "$DIR/versions"
chmod 0755 "$DIR" "$DIR/versions"
exec 9>"$DIR/.lock"
flock -w 600 9 || die "another update holds $DIR/.lock"

swap() { # swap <link target> <version text>
  ln -sfn "$1" "$DIR/.pyry.new"
  mv -fT "$DIR/.pyry.new" "$DIR/pyry"
  printf '%s\n' "$2" > "$DIR/.VERSION.new"
  chmod 0644 "$DIR/.VERSION.new"
  mv -f "$DIR/.VERSION.new" "$DIR/VERSION"
}

case "$cmd" in
  status) status; exit 0 ;;
  image) swap /usr/local/bin/pyry image; status; exit 0 ;;
  latest)
    tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')" \
      || die "could not read the latest release"
    ;;
  v[0-9]*.[0-9]*.[0-9]*) tag="$cmd" ;;
  *) usage ;;
esac

version="${tag#v}"
asset="pyry_${version}_Linux_x86_64.tar.gz"
base="https://github.com/$REPO/releases/download/$tag"

if [ "$(cat "$DIR/VERSION" 2>/dev/null)" = "$version" ] && [ -x "$DIR/versions/$version/pyry" ] \
   && [ "$(readlink "$DIR/pyry")" = "versions/$version/pyry" ]; then
  echo "$(hostname): $version already installed"; status; exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for f in "$asset" checksums.txt checksums.txt.sig; do
  curl -fsSL --retry 3 -o "$work/$f" "$base/$f" || die "download failed: $base/$f"
done

# Ed25519 public key as DER: the fixed SubjectPublicKeyInfo prefix plus the key.
python3 -c 'import sys; sys.stdout.buffer.write(bytes.fromhex("302a300506032b6570032100" + sys.argv[1]))' \
  "$SIGNING_KEY_HEX" > "$work/key.der"
openssl pkey -pubin -inform DER -in "$work/key.der" -out "$work/key.pem" 2>/dev/null
openssl pkeyutl -verify -pubin -inkey "$work/key.pem" -rawin \
  -in "$work/checksums.txt" -sigfile "$work/checksums.txt.sig" >/dev/null 2>&1 \
  || die "checksums.txt signature does not verify for $tag; nothing installed"

want="$(awk -v a="$asset" '$2 == a { print $1 }' "$work/checksums.txt")"
[[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "no checksum for $asset in checksums.txt"
got="$(sha256sum "$work/$asset" | awk '{print $1}')"
[ "$got" = "$want" ] || die "SHA-256 mismatch for $asset; nothing installed"

tar -xzf "$work/$asset" -C "$work" pyry || die "no pyry in $asset"
reported="$("$work/pyry" --version 2>&1 || true)"
[ "$reported" = "pyry $version" ] || die "binary reports '$reported', expected 'pyry $version'"

dest="$DIR/versions/$version"
rm -rf "$dest.tmp"
mkdir -p "$dest.tmp"
install -m 0555 "$work/pyry" "$dest.tmp/pyry"
rm -rf "$dest"
mv -T "$dest.tmp" "$dest"
swap "versions/$version/pyry" "$version"

# Keep the newest few releases for a quick roll back; never the one in use.
current="$(readlink "$DIR/pyry")"
ls -1 "$DIR/versions" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | head -n "-$KEEP" | while read -r old; do
  [ "versions/$old/pyry" = "$current" ] || rm -rf "${DIR:?}/versions/$old"
done

echo "$(hostname): installed $tag (signature and SHA-256 verified)"
status
