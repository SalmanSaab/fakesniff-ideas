#!/usr/bin/env bash
# FAKESNIFF Hub — deploy the site.
#
# This exists because I hand-listed the files to copy when creating the
# production deploy, forgot the two shirt images, and the Idea Lab rendered
# blank boxes on production while looking fine on staging. A hand-maintained
# list of files silently rots every time someone adds one.
#
# So: ship everything the site needs, and name only what must NOT ship.
#
#   ./deploy.sh prod      the real hub
#   ./deploy.sh staging   the throwaway copy
#   ./deploy.sh both
#
# hub-config.js is never copied from here. Each deploy keeps its own, because
# that file is the only thing that decides which database the hub talks to and
# overwriting it is how staging silently becomes production.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$(command -v python || command -v python3)"
TMP="${TEMP:-/tmp}"
PROD="$TMP/hubprod"
STAGE="$TMP/hubstage"

# Anything not shipped to the browser. Source, tests, database, notes.
EXCLUDE=(
  "supabase" "tests" "migrations" "node_modules" ".git" ".github"
  "*.md" "*.sql" "*.py" "*.sh" "package.json" "package-lock.json"
  "hub-config.js" "hub-config.production.js" "hub-preview.local.*"
)

copy_into() {
  local dest="$1" name="$2"
  [ -d "$dest" ] || { echo "  $name: $dest is missing — clone it first"; return 1; }

  local args=()
  for pattern in "${EXCLUDE[@]}"; do args+=(--exclude="$pattern"); done

  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${args[@]}" "$SRC"/ "$dest"/
  else
    # Windows git-bash often has no rsync; do it by hand.
    find "$SRC" -maxdepth 1 -type f | while read -r f; do
      local b; b="$(basename "$f")"
      local skip=""
      for pattern in "${EXCLUDE[@]}"; do
        case "$b" in $pattern) skip=1 ;; esac
      done
      [ -z "$skip" ] && cp "$f" "$dest/"
    done
  fi

  # Claude — 2026-08-13: stamp every local script and stylesheet with the
  # deploy time. Without this the browser keeps serving the previous copy from
  # cache and a deploy appears to do nothing — we lost a good part of an
  # evening to "it is live on the server but the page has not changed", and
  # telling someone to hard-refresh is a workaround, not a fix.
  "$PYTHON" "$SRC/stamp_assets.py" "$dest/hub.html" || echo "  $name: WARNING could not stamp assets"

  # The root URL must be the same shell as hub.html, or a stale copy of it
  # gets served the current JavaScript and the page hangs. That happened.
  cp "$dest/hub.html" "$dest/index.html"

  local missing=0
  while read -r asset; do
    [ -f "$dest/$asset" ] || { echo "  MISSING in $name: $asset"; missing=1; }
  done < <(grep -ohE '(src|href)="[^"h][^"]*\.(js|css|jpg|jpeg|png|webp|svg)"' "$dest/hub.html" \
           | sed 's/.*="//;s/"//' | sort -u)
  # Assets modules load themselves, which the HTML never mentions. These are a
  # warning rather than a failure: the same pattern matches default filenames
  # in upload code (photo.jpg), which are not assets and never will be.
  for asset in $(grep -ohE 'new URL\("[a-z0-9-]+\.(css|jpg|png)"|src="[a-z0-9-]+\.(jpg|png|webp)"' "$dest"/hub-*.js 2>/dev/null                  | grep -oE '[a-z0-9-]+\.(css|jpg|png|webp)' | sort -u); do
    [ -f "$dest/$asset" ] || echo "  note, $name: $asset is referenced by a module but not shipped"
  done
  [ "$missing" -eq 0 ] && echo "  $name: every referenced asset is present"
  return $missing
}

push() {
  local dest="$1" name="$2" msg="$3"
  ( cd "$dest"
    git add -A
    if git diff --cached --quiet; then echo "  $name: nothing changed"; else
      git -c user.name="SalmanSaab" -c user.email="salmansaab35@gmail.com" commit -q -m "$msg"
      git push -q origin HEAD
      echo "  $name: deployed"
    fi )
}

TARGET="${1:-both}"
MSG="${2:-Claude — deploy}"

case "$TARGET" in
  prod)    copy_into "$PROD" production && push "$PROD" production "$MSG" ;;
  staging) copy_into "$STAGE" staging   && push "$STAGE" staging "$MSG" ;;
  both)
    copy_into "$PROD" production && push "$PROD" production "$MSG"
    copy_into "$STAGE" staging   && push "$STAGE" staging "$MSG"
    ;;
  *) echo "usage: ./deploy.sh [prod|staging|both] [message]"; exit 1 ;;
esac
