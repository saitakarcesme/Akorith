#!/usr/bin/env bash
#
# Phase 36: safely refresh the installed macOS Akorith.app.
#
# It NEVER uses `rm -rf` on apps: old Akorith.app copies are MOVED to a timestamped
# backup folder on the Desktop. It only touches files named exactly "Akorith.app" in
# the standard locations below — never unrelated apps, never the repo, never user
# config/data (~/Library/Application Support/akorith is left untouched).
#
# Usage:
#   bash scripts/refresh-macos-app.sh           # audit + backup old + install newest build
#   bash scripts/refresh-macos-app.sh --audit   # only report what would happen
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

echo "== Akorith macOS app refresh =="

# 1) Locate the freshly built .app (electron-builder --dir output under dist/).
BUILT_APP=""
for d in "$REPO_ROOT"/dist/mac*/Akorith.app "$REPO_ROOT"/dist/Akorith.app; do
  if [ -d "$d" ]; then BUILT_APP="$d"; break; fi
done

if [ -z "$BUILT_APP" ]; then
  echo "No freshly built Akorith.app found under dist/. Run: npm run pack:mac"
  BUILT_FOUND=0
else
  echo "Built app: $BUILT_APP"
  BUILT_FOUND=1
fi

# 2) Audit existing copies.
echo "-- existing Akorith.app copies --"
FOUND_COPIES=()
for dir in "${CANDIDATE_DIRS[@]}"; do
  app="$dir/Akorith.app"
  if [ -d "$app" ]; then
    echo "  found: $app"
    FOUND_COPIES+=("$app")
  fi
done
[ "${#FOUND_COPIES[@]}" -eq 0 ] && echo "  (none)"

if [ "$AUDIT_ONLY" -eq 1 ]; then
  echo "(audit only — nothing moved or installed)"
  exit 0
fi

# 3) Gracefully quit a running Akorith (only the Akorith app, nothing else).
osascript -e 'tell application "Akorith" to quit' >/dev/null 2>&1 || true
sleep 1

# 4) Back up old copies (move, never delete).
if [ "${#FOUND_COPIES[@]}" -gt 0 ]; then
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
fi

# 5) Install the newest build.
if [ "$BUILT_FOUND" -eq 1 ]; then
  TARGET_DIR="/Applications"
  if [ ! -w "$TARGET_DIR" ]; then
    TARGET_DIR="$HOME/Applications"
    mkdir -p "$TARGET_DIR"
    echo "/Applications not writable — installing to $TARGET_DIR"
  fi
  TARGET="$TARGET_DIR/Akorith.app"
  if ditto "$BUILT_APP" "$TARGET" 2>/dev/null; then
    echo "Installed: $TARGET"
    VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$TARGET/Contents/Info.plist" 2>/dev/null || echo '?')"
    echo "Version: $VER"
  else
    echo "PERMISSION: could not install to $TARGET (try: sudo ditto \"$BUILT_APP\" \"$TARGET\")"
  fi
fi

echo "== done =="
