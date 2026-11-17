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
if [ -n "${CANVAS_REPO:-}" ]; then
  plutil -insert CanvasRepo -string "$CANVAS_REPO" "$APP/Contents/Info.plist"
fi
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp Harness/*.png "$APP/Contents/Resources/"
swiftc "${SWIFT_OPT:--O}" ${QA_FLAGS[@]+"${QA_FLAGS[@]}"} main.swift Model.swift Shell.swift Fonts.swift Inspector.swift Widgets.swift Keychain.swift Bridge.swift Pages.swift Library.swift InspectorTokens.swift ShellLogic.swift PaperShaders.swift ResourceMeterLogic.swift ResourceMeter.swift LayoutLogic.swift InspectorLayout.swift PaintLogic.swift InspectorPaint.swift PaintEditor.swift InspectorExport.swift InspectorGuides.swift LayersLogic.swift Layers.swift PaletteLogic.swift Palette.swift Spark.swift SettingsLogic.swift Settings.swift ${QA_SRC[@]+"${QA_SRC[@]}"} DesignSystem/*.swift -o "$APP/Contents/MacOS/Canvas"
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
codesign --force --sign "${ID:--}" "$APP" 2>/dev/null || codesign --force --sign - "$APP" 2>/dev/null || true
echo "built $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
