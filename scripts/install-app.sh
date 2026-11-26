#!/bin/bash
# Put a built Canvas.app in /Applications and prove the app that runs afterwards is that build.
#   scripts/install-app.sh <built.app> [--no-open]   quit the installed app, replace it, open it, verify
#   scripts/install-app.sh --verify <pid> <app>      exit 0 only if <pid> runs <app>'s binary (the same file)
#   CANVAS_INSTALL_DIR overrides /Applications; CANVAS_INSTALL_NO_OPEN=1 is --no-open. Tests use only --verify,
#   which never quits, opens or launches anything.
#
# Why the check: an app that is still running when its bundle is replaced keeps running the old binary (moved to
# the Trash, still mapped), and a launch that races the swap starts the old one. The Info.plist on disk then names
# the new commit while the process on screen is the old build. Only the running process's binary proves an install.
set -euo pipefail

exe_of() { /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist"; }

# The inode of the executable a process runs, from its mapped text files.
running_inode() {
  local pid="$1" name="$2"
  lsof -a -p "$pid" -d txt -Fin 2>/dev/null | awk -v want="/Contents/MacOS/$name" '
    /^i/ { inode = substr($0, 2) }
    /^n/ { path = substr($0, 2); if (substr(path, length(path) - length(want) + 1) == want) { print inode; exit } }'
}

verify() {
  local pid="$1" app="$2" exe have want
  exe="$(exe_of "$app")"
  want="$(stat -f %i "$app/Contents/MacOS/$exe")"
  have="$(running_inode "$pid" "$exe")"
  if [ -z "$have" ]; then echo "install-app: process $pid runs no $exe binary" >&2; return 1; fi
  if [ "$have" != "$want" ]; then
    echo "install-app: process $pid runs a stale $exe (inode $have), not $app (inode $want)" >&2
    return 1
  fi
}

if [ "${1:-}" = "--verify" ]; then verify "$2" "$3"; exit $?; fi

SRC="${1:?usage: scripts/install-app.sh <built.app> [--no-open]}"
OPEN=1; { [ "${2:-}" = "--no-open" ] || [ "${CANVAS_INSTALL_NO_OPEN:-}" = 1 ]; } && OPEN=0
DEST="${CANVAS_INSTALL_DIR:-/Applications}/$(basename "$SRC")"
EXE="$(exe_of "$SRC")"
BIN="$DEST/Contents/MacOS/$EXE"
ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SRC/Contents/Info.plist")"

# Quit, never kill: the app waits for its last edit to save. Then wait for every process of the old bundle to end.
if pgrep -f "^$BIN" >/dev/null; then
  osascript -e "tell application id \"$ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 120); do pgrep -f "^$BIN" >/dev/null || break; sleep 0.5; done
  if pgrep -f "^$BIN" >/dev/null; then echo "install-app: $DEST is still running; quit it and run again" >&2; exit 1; fi
fi

OLD=""
if [ -e "$DEST" ]; then OLD="$(mktemp -d)/$(basename "$DEST")"; mv "$DEST" "$OLD"; fi
ditto "$SRC" "$DEST"
if [ -n "$OLD" ]; then
  if [ -x /usr/bin/trash ]; then /usr/bin/trash "$OLD" >/dev/null 2>&1 || rm -rf "$OLD"; else rm -rf "$OLD"; fi
fi

COMMIT="$(/usr/libexec/PlistBuddy -c 'Print :CanvasCommit' "$DEST/Contents/Info.plist" 2>/dev/null || echo unknown)"
[ "$OPEN" = 1 ] || { echo "installed $DEST ($COMMIT)"; exit 0; }

open "$DEST"
PID=""
for _ in $(seq 60); do PID="$(pgrep -f "^$BIN" | head -1 || true)"; [ -n "$PID" ] && break; sleep 0.5; done
[ -n "$PID" ] || { echo "install-app: $DEST did not start" >&2; exit 1; }
verify "$PID" "$DEST"
echo "installed $DEST ($COMMIT), running as pid $PID from the new binary"
