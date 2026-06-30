#!/usr/bin/env bash
#
# Phase 41: safely clean up old macOS Akorith.app copies.
#
# It NEVER deletes: old copies are MOVED to a timestamped backup folder on the
# Desktop. It only considers files named exactly "Akorith.app" in the standard
# locations below — never unrelated apps, never the repo, never user
# config/data (~/Library/Application Support/akorith* is left untouched).
#
# This is the cleanup half of refresh-macos-app.sh, on its own (no build/install).
#
# Usage:
#   bash scripts/clean-old-akorith-apps.sh           # audit + back up old copies
#   bash scripts/clean-old-akorith-apps.sh --audit   # only report what would happen
#
set -euo pipefail

AUDIT_ONLY=0
[ "${1:-}" = "--audit" ] && AUDIT_ONLY=1

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME/Desktop/Akorith-old-apps-$STAMP"

# Only these exact locations / names are considered.
CANDIDATE_DIRS=(
  "/Applications"
  "$HOME/Applications"
  "$HOME/Desktop"
  "$HOME/Downloads"
)

echo "== Akorith app cleanup =="

FOUND_COPIES=()
for dir in "${CANDIDATE_DIRS[@]}"; do
  app="$dir/Akorith.app"
  if [ -d "$app" ]; then
    echo "  found: $app"
    FOUND_COPIES+=("$app")
  fi
done

if [ "${#FOUND_COPIES[@]}" -eq 0 ]; then
  echo "  (no Akorith.app copies found)"
  exit 0
fi

if [ "$AUDIT_ONLY" -eq 1 ]; then
  echo "(audit only — nothing moved)"
  exit 0
fi

# Quit a running Akorith (only Akorith) before moving its bundle.
osascript -e 'tell application "Akorith" to quit' >/dev/null 2>&1 || true
sleep 1

mkdir -p "$BACKUP_DIR"
for app in "${FOUND_COPIES[@]}"; do
  base="$(basename "$(dirname "$app")")"
  dest="$BACKUP_DIR/${base}-Akorith.app"
  if mv "$app" "$dest" 2>/dev/null; then
    echo "  backed up: $app -> $dest"
  else
    echo "  PERMISSION: could not move $app (try: sudo mv \"$app\" \"$dest\")"
  fi
done
echo "Backup folder: $BACKUP_DIR"
echo "User data/config/db were NOT touched."
echo "== done =="
