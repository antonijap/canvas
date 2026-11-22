#!/bin/bash
# pnpm release:app: a Canvas.app people can download and run, in qa/out/release/<version>/ (git ignores qa/out):
#   Canvas.app             built by apps/macos/build.sh, with everything it runs inside it: Node (Resources/node), the
#                          server, the MCP server, the drawing engine and the course file (Resources/server, with its
#                          production dependencies). No checkout, Node install or Rust toolchain is needed to run it.
#   Canvas-<version>.zip   the app zipped with ditto (keeps the signature and symlinks), the file to upload
#   RELEASE-NOTES.md       version, commit, checksum, signature, notarization, requirements and the changes
# It never tags, pushes, uploads or makes a GitHub release: publishing is the maintainer's call.
#
#   CANVAS_SIGN_IDENTITY=-              ad-hoc signature (a test run that must not touch the keychain)
#   CANVAS_SIGN_IDENTITY="Developer ID Application: ..."   (default: the first Developer ID identity in the keychain)
#   CANVAS_NOTARY_PROFILE=<name>        notarize and staple with that notarytool keychain profile (default: the team's
#                                       `apple-notary`, else `worktrees-notary`; `none` skips notarizing, local tests only)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
fail() { printf 'pnpm release:app: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || fail "Canvas.app builds on macOS only"
VERSION="$(node -p 'require("./package.json").version')"
PLIST="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Info.plist)"
[ "$VERSION" = "$PLIST" ] || fail "package.json says $VERSION and apps/macos/Info.plist says $PLIST: make them the same version first"
scripts/ensure-engine.sh || fail "the engine build failed: run pnpm build:engine to see why"
[ -f engine/pkg/canvas_engine.js ] || fail "no engine build in engine/pkg: run pnpm build:engine first"

ID="${CANVAS_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)}"
[ -n "$ID" ] || fail "no Developer ID Application identity in the keychain (CANVAS_SIGN_IDENTITY=- for an ad-hoc test build)"

OUT="qa/out/release/$VERSION"
ZIP="Canvas-$VERSION.zip"
APP="$OUT/Canvas.app"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "Building Canvas.app $VERSION"
# No CANVAS_REPO: a release runs the server inside it, never a checkout's path.
CANVAS_REQUIRE_TUNNEL=1 CANVAS_SIGN_IDENTITY=- CANVAS_APP_OUT="$ROOT/$APP" apps/macos/build.sh >/dev/null

# The binary must open on every macOS Info.plist allows: its build minimum and LSMinimumSystemVersion are the same.
BIN_MINOS="$(vtool -show-build "$APP/Contents/MacOS/Canvas" | awk '/minos/ {print $2; exit}')"
APP_MINOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist")"
[ "$BIN_MINOS" = "$APP_MINOS" ] || fail "the app binary needs macOS $BIN_MINOS but Info.plist says $APP_MINOS"

echo "Adding the server, the engine and Node"
SRV="$APP/Contents/Resources/server"
mkdir -p "$SRV/engine/src" "$SRV/demos"
# What the server reads at run time (src/, mcp/, the vendored shader library, the engine build, the paper noise texture, the course file), nothing
# else: no tests, QA, docs or sources it does not load.
rsync -a --exclude '.*' src mcp vendor package.json pnpm-lock.yaml pnpm-workspace.yaml "$SRV/"
# The comments protocol the server shares with a team's own Canvas server (src/comments.ts imports it).
mkdir -p "$SRV/cloud" && cp cloud/*.ts "$SRV/cloud/"
# A Cloud hosted on a Mac (src/cloud-host.ts) runs cloud/adapters/mac with the room and team logic it shares with the Worker.
rsync -a --exclude '.*' cloud/core "$SRV/cloud/"
mkdir -p "$SRV/cloud/adapters"
rsync -a --exclude '.*' cloud/adapters/mac "$SRV/cloud/adapters/"
rsync -a --exclude '.*' engine/pkg "$SRV/engine/"
cp engine/src/paper_noise.rgba "$SRV/engine/src/"
rsync -a --exclude '.*' demos/learn.canvas "$SRV/demos/"
cp LICENSE NOTICE THIRD_PARTY_NOTICES.md "$SRV/"
# Production dependencies only, exactly the lockfile's, no install scripts, as plain folders (no symlinks to a store).
(cd "$SRV" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent)
rm -f "$SRV/pnpm-lock.yaml" "$SRV/pnpm-workspace.yaml"
find "$SRV/node_modules" -name '*.node' -print | grep -q . && fail "a dependency ships a native module: sign it or drop it"
# Node itself: the one running this script (mise's Node 24), with its licence.
NODE="$(node -p 'process.execPath')"
NODE_DIR="$(cd "$(dirname "$NODE")/.." && pwd)"
mkdir -p "$APP/Contents/Resources/node/bin"
cp "$NODE" "$APP/Contents/Resources/node/bin/node"
cp "$NODE_DIR/LICENSE" "$APP/Contents/Resources/node/LICENSE" 2>/dev/null || true
NODE_VERSION="$("$APP/Contents/Resources/node/bin/node" --version)"

echo "Signing with: $ID"
# Inside out: Node first (V8 needs JIT under the hardened runtime), then the app, which seals everything else.
ENT="$(mktemp -d)/node.entitlements"
cat > "$ENT" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
PLIST
TS=(--timestamp)
[ "$ID" = "-" ] && TS=()
codesign --force --options runtime "${TS[@]}" --entitlements "$ENT" --sign "$ID" "$APP/Contents/Resources/node/bin/node"
# The tunnel helper is signed inside the app, with the hardened runtime, like Node.
codesign --force --options runtime "${TS[@]}" --sign "$ID" "$APP/Contents/Resources/canvas-tunnel"
codesign --force --options runtime "${TS[@]}" --sign "$ID" "$APP"
codesign --verify --deep --strict "$APP" || fail "the built app's signature does not verify"

NOTARIZED="no"
# The team's shared profile: apple-notary, else its older name worktrees-notary.
if [ -z "${CANVAS_NOTARY_PROFILE:-}" ]; then
  for p in apple-notary worktrees-notary; do
    if xcrun notarytool history --keychain-profile "$p" >/dev/null 2>&1; then CANVAS_NOTARY_PROFILE="$p"; break; fi
  done
fi
if [ -n "${CANVAS_NOTARY_PROFILE:-}" ] && [ "$CANVAS_NOTARY_PROFILE" != none ] && [ "$ID" != "-" ]; then
  echo "Notarizing (a few minutes)"
  (cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent Canvas.app notarize.zip)
  xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$CANVAS_NOTARY_PROFILE" --wait | tee "$OUT/notarytool.log"
  grep -q 'status: Accepted' "$OUT/notarytool.log" || fail "notarization was not accepted: see $OUT/notarytool.log"
  xcrun stapler staple "$APP"
  rm -f "$OUT/notarize.zip"
  NOTARIZED="yes, stapled"
fi
spctl --assess --type execute "$APP" >/dev/null 2>&1 && GATEKEEPER="accepted" || GATEKEEPER="rejected (not notarized yet)"
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent Canvas.app "$ZIP")

SHA="$(shasum -a 256 "$OUT/$ZIP" | awk '{print $1}')"
BYTES="$(stat -f %z "$OUT/$ZIP")"
COMMIT="$(git rev-parse --short HEAD)"
DIRTY=""
[ -z "$(git status --porcelain --untracked-files=no)" ] || DIRTY=" (with uncommitted changes: commit them and build again before you publish)"
SIGNER="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | sed -n 1p)"
[ -n "$SIGNER" ] || SIGNER="ad-hoc (no identity)"
MINOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' apps/macos/Info.plist 2>/dev/null || echo 13.0)"
ARCH="$(lipo -archs "$APP/Contents/MacOS/Canvas" | sed "s/ / and /; s/arm64/Apple silicon/; s/x86_64/Intel/")"
SINCE="$(git describe --tags --abbrev=0 2>/dev/null || true)"
CHANGES="$(git log -n 150 --no-merges --pretty="- %s" ${SINCE:+"$SINCE"..HEAD})"

cat > "$OUT/RELEASE-NOTES.md" <<EOF
# Canvas $VERSION (alpha)

Draft notes for the maintainer to edit. Nothing is published: no tag, no upload, no GitHub release.

| | |
|---|---|
| File | \`$ZIP\` ($BYTES bytes) |
| SHA-256 | \`$SHA\` |
| Commit | \`$COMMIT\`$DIRTY |
| Built | $(date -u +%Y-%m-%dT%H:%MZ) |
| Signed by | $SIGNER |
| Notarized | $NOTARIZED |
| Gatekeeper | $GATEKEEPER |
| Node inside | $NODE_VERSION |

## Requirements

- macOS $MINOS or later, $ARCH
- Nothing else to install. Exports and agent renders use Google Chrome (or another Chromium browser) when one is there.

## Changes${SINCE:+ since $SINCE}

$CHANGES
EOF

echo "Ready in $OUT:"
echo "  $ZIP  sha256 $SHA  ($BYTES bytes)"
echo "  notarized: $NOTARIZED; Gatekeeper: $GATEKEEPER"
echo "Nothing was published."
