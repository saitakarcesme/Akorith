#!/usr/bin/env bash
# Extract and launch the exact ZIP that will be published, not only electron-builder's app folder.
set -euo pipefail

ZIP_PATH="${1:-}"
if [ -z "$ZIP_PATH" ]; then
  ZIP_PATH="$(find dist -maxdepth 1 -type f -name 'Akorith-*-mac-*.zip' -print0 | xargs -0 ls -t 2>/dev/null | head -1 || true)"
fi

if [ -z "$ZIP_PATH" ] || [ ! -f "$ZIP_PATH" ]; then
  echo "No packaged Akorith macOS ZIP found to verify."
  exit 1
fi

EXTRACT_DIR="$(mktemp -d -t akorith-release-artifact)"
cleanup() {
  find "$EXTRACT_DIR" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

ditto -x -k "$ZIP_PATH" "$EXTRACT_DIR"

if [ ! -d "$EXTRACT_DIR/Akorith.app" ]; then
  echo "Packaged ZIP does not contain Akorith.app at its root: $ZIP_PATH"
  exit 1
fi

bash "$(dirname "$0")/verify-macos-app.sh" "$EXTRACT_DIR/Akorith.app"
echo "Packaged macOS ZIP passed extraction and launch verification: $ZIP_PATH"
