#!/usr/bin/env bash
# Verify both the static signature and a real launch before a macOS app is released/installed.
set -euo pipefail

APP_PATH="${1:-}"
if [ -z "$APP_PATH" ]; then
  for candidate in dist/mac*/Akorith.app dist/Akorith.app; do
    if [ -d "$candidate" ]; then
      APP_PATH="$candidate"
      break
    fi
  done
fi

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "No Akorith.app bundle found to verify."
  exit 1
fi

EXECUTABLE="$APP_PATH/Contents/MacOS/Akorith"
FRAMEWORK="$APP_PATH/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
ENTITLEMENTS_FILE="$(mktemp -t akorith-entitlements)"
LAUNCH_LOG="$(mktemp -t akorith-launch)"

cleanup() {
  if [ -n "${APP_PID:-}" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$APP_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -f "$ENTITLEMENTS_FILE" "$LAUNCH_LOG"
}
trap cleanup EXIT

test -x "$EXECUTABLE"
test -f "$FRAMEWORK"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign --verify --strict --verbose=2 "$FRAMEWORK"
codesign -d --entitlements :- "$APP_PATH" >"$ENTITLEMENTS_FILE" 2>/dev/null

if [ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$ENTITLEMENTS_FILE" 2>/dev/null || true)" != "true" ]; then
  echo "Akorith.app is missing com.apple.security.cs.disable-library-validation."
  exit 1
fi

ELECTRON_ENABLE_LOGGING=1 "$EXECUTABLE" --disable-gpu >"$LAUNCH_LOG" 2>&1 &
APP_PID=$!
sleep "${AKORITH_LAUNCH_SMOKE_SECONDS:-5}"

if ! kill -0 "$APP_PID" 2>/dev/null; then
  STATUS=0
  wait "$APP_PID" || STATUS=$?
  echo "Akorith.app exited during launch smoke test (status $STATUS)."
  sed -n '1,160p' "$LAUNCH_LOG"
  exit 1
fi

echo "Akorith.app signature, entitlements, and launch smoke test passed: $APP_PATH"
