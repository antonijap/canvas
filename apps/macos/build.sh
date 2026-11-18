#!/bin/bash
# Build Canvas.app: swiftc, no Xcode project needed.
#   QA=1 apps/macos/build.sh    a QA build for pnpm qa:native: adds QA.swift with -D CANVAS_QA (bridge ops that post
#                               input into its own window), its own bundle id. Never the app you ship or commit.
#   CANVAS_APP_OUT=/path/X.app  writes the app there instead of apps/macos/Canvas.app.
#   CANVAS_REPO=/path/to/canvas the checkout whose server the app runs (Info.plist CanvasRepo; pnpm app sets it).
#                               Unset: CANVAS_SERVER at launch, else ~/Code/canvas. Never set for the tracked app.
set -e
cd "$(dirname "$0")"
APP="${CANVAS_APP_OUT:-Canvas.app}"
QA_FLAGS=()
QA_SRC=()
if [ "${QA:-}" = "1" ]; then
  QA_FLAGS=(-D CANVAS_QA)
  QA_SRC=(QA.swift)
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
# The commit it was built from: Help > Report a Bug sends it with the report (nothing else about the build).
COMMIT="$(git -C .. rev-parse --short HEAD 2>/dev/null || true)"
[ -n "$COMMIT" ] && plutil -insert CanvasCommit -string "$COMMIT" "$APP/Contents/Info.plist"
# When it was built (UTC), for Canvas > About Canvas.
plutil -insert CanvasBuilt -string "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$APP/Contents/Info.plist"
if [ -n "${CANVAS_REPO:-}" ]; then
  plutil -insert CanvasRepo -string "$CANVAS_REPO" "$APP/Contents/Info.plist"
fi
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# Build for the oldest macOS Info.plist promises, not for the Mac building it: without -target swiftc stamps the
# host's version into the binary and the app will not open on anything older.
MINOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' Info.plist)"
swiftc "${SWIFT_OPT:--O}" -target "$(uname -m)-apple-macos$MINOS" ${QA_FLAGS[@]+"${QA_FLAGS[@]}"} main.swift Model.swift Shell.swift Fonts.swift Inspector.swift Widgets.swift Keychain.swift Bridge.swift Pages.swift Library.swift InspectorTokens.swift ShellLogic.swift Updater.swift PaperShaders.swift ResourceMeterLogic.swift ResourceMeter.swift LayoutLogic.swift InspectorLayout.swift PaintLogic.swift InspectorPaint.swift PaintEditor.swift InspectorExport.swift InspectorGuides.swift LayersLogic.swift Layers.swift PaletteLogic.swift Palette.swift Spark.swift SettingsLogic.swift Settings.swift CloudPicker.swift CloudSettings.swift HomeLogic.swift Home.swift ${QA_SRC[@]+"${QA_SRC[@]}"} DesignSystem/*.swift -o "$APP/Contents/MacOS/Canvas"
# The tunnel helper a hosted Cloud is reached through (cloud/tunnel, the tailcat library at a pinned version). Built
# from source when Go is installed; without it the build goes on and Settings > Cloud > Host on this Mac is off.
# CANVAS_REQUIRE_TUNNEL=1 (scripts/release-app.sh) makes a missing helper an error: a release always has it.
# Go: on PATH, else through mise (the Go version cloud/tunnel/go.mod names). The module graph is go.sum's, nothing newer.
GO=()
if command -v go >/dev/null 2>&1; then GO=(go)
elif command -v mise >/dev/null 2>&1 && mise exec go@1.27 -- go version >/dev/null 2>&1; then GO=(mise exec go@1.27 -- go)
fi
HELPER_OUT="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")/Contents/Resources/canvas-tunnel"
if [ ${#GO[@]} -gt 0 ] && [ -f ../../cloud/tunnel/go.sum ]; then
  (cd ../../cloud/tunnel && CGO_ENABLED=0 GOFLAGS=-mod=readonly GOTOOLCHAIN=local "${GO[@]}" build -mod=readonly -trimpath -ldflags="-s -w" -o "$HELPER_OUT" .)
  # Signed inside the app (ad-hoc here; scripts/release-app.sh signs it again with the release identity).
  codesign --force --sign - "$HELPER_OUT" 2>/dev/null || true
elif [ "${CANVAS_REQUIRE_TUNNEL:-}" = "1" ]; then
  echo "error: no tunnel helper: a release needs Go (mise use -g go@1.27) to build cloud/tunnel" >&2
  exit 1
else
  echo "note: no Go, so no tunnel helper in this build: Settings > Cloud > Host a Cloud is off (mise use -g go@1.27 to build it)"
fi
if [ "${QA:-}" = "1" ]; then
  # Its own identity: own preferences and WebKit storage, never mistaken for the real app. No canvas:// scheme:
  # Launch Services must never send the person's links to a QA build (scenarios deliver them in-process).
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier cc.getcanvas.canvas.qa" -c "Set :CFBundleName Canvas QA" -c "Set :CFBundleDisplayName Canvas QA" -c "Delete :CFBundleURLTypes" "$APP/Contents/Info.plist"
  codesign --force --sign - "$APP" 2>/dev/null || true
  echo "built $APP (QA)"
  exit 0
fi
# A stable signing identity keeps macOS privacy grants (Desktop/Documents access) across rebuilds;
# an ad-hoc signature changes every build and macOS asks again. CANVAS_SIGN_IDENTITY overrides.
ID="${CANVAS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)}"
if [ -f "$HELPER_OUT" ]; then codesign --force --sign "${ID:--}" "$HELPER_OUT" 2>/dev/null || codesign --force --sign - "$HELPER_OUT" 2>/dev/null || true; fi
codesign --force --sign "${ID:--}" "$APP" 2>/dev/null || codesign --force --sign - "$APP" 2>/dev/null || true
echo "built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
