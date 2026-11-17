#!/bin/bash
# pnpm release:app: everything a Canvas.app release needs, in qa/out/release/<version>/ (git ignores qa/out):
#   Canvas.app             built by apps/macos/build.sh (never the tracked apps/macos/Canvas.app)
#   Canvas-<version>.zip   the app zipped with ditto (keeps the signature and symlinks), the file to upload
#   RELEASE-NOTES.md       version, commit, checksum, signature, requirements and the changes since the last tag
# It only prepares. It never tags, pushes, uploads or makes a GitHub release: publishing is the maintainer's call.
#   CANVAS_SIGN_IDENTITY=-   ad-hoc signature (a test run that must not touch the keychain)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
fail() { printf 'pnpm release:app: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || fail "Canvas.app builds on macOS only"
VERSION="$(node -p 'require("./package.json").version')"
PLIST="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Info.plist)"
[ "$VERSION" = "$PLIST" ] || fail "package.json says $VERSION and apps/macos/Info.plist says $PLIST: make them the same version first"
[ -f engine/pkg/canvas_engine.js ] || fail "no engine build in engine/pkg: run pnpm build:engine first"

OUT="qa/out/release/$VERSION"
ZIP="Canvas-$VERSION.zip"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "Building Canvas.app $VERSION"
CANVAS_APP_OUT="$ROOT/$OUT/Canvas.app" apps/macos/build.sh >/dev/null
codesign --verify --deep --strict "$OUT/Canvas.app" || fail "the built app's signature does not verify"
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent Canvas.app "$ZIP")

SHA="$(shasum -a 256 "$OUT/$ZIP" | awk '{print $1}')"
BYTES="$(stat -f %z "$OUT/$ZIP")"
COMMIT="$(git rev-parse --short HEAD)"
DIRTY=""
[ -z "$(git status --porcelain --untracked-files=no)" ] || DIRTY=" (with uncommitted changes: commit them and build again before you publish)"
SIGNER="$(codesign -dv "$OUT/Canvas.app" 2>&1 | sed -n 's/^Authority=//p' | sed -n 1p)"
[ -n "$SIGNER" ] || SIGNER="ad-hoc (no identity)"
MINOS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' apps/macos/Info.plist 2>/dev/null || echo 13.0)"
ARCH="$(lipo -archs "$OUT/Canvas.app/Contents/MacOS/Canvas" | sed "s/ / and /; s/arm64/Apple silicon/; s/x86_64/Intel/")"
SINCE="$(git describe --tags --abbrev=0 2>/dev/null || true)"
CHANGES="$(git log -n 150 --no-merges --pretty="- %s" ${SINCE:+"$SINCE"..HEAD})"

cat > "$OUT/RELEASE-NOTES.md" <<EOF
# Canvas $VERSION

Draft notes for the maintainer to edit. Nothing is published: no tag, no upload, no GitHub release.

| | |
|---|---|
| File | \`$ZIP\` ($BYTES bytes) |
| SHA-256 | \`$SHA\` |
| Commit | \`$COMMIT\`$DIRTY |
| Built | $(date -u +%Y-%m-%dT%H:%MZ) |
| Signed by | $SIGNER |

## Before publishing

- The app is signed with the identity above, not with a Developer ID, and it is not notarized. People who download it
  get a Gatekeeper warning. To ship it outside this Mac: sign with a Developer ID Application identity
  (\`CANVAS_SIGN_IDENTITY="Developer ID Application: ..." pnpm release:app\`), then \`xcrun notarytool submit $ZIP --wait\`
  and \`xcrun stapler staple Canvas.app\`, and zip again.
- Canvas.app runs its server from a Canvas checkout: \`~/Code/canvas\`, or the path in \`CANVAS_SERVER\`. Say so on the
  release page, or point people at \`pnpm app\`, which builds the app from their own clone.

## Requirements

- macOS $MINOS or later, $ARCH only: the build is for this Mac's architecture
- Node 22.18 or later (the app finds mise, Homebrew or PATH installs)
- A Canvas checkout with dependencies installed and the engine built (\`pnpm app\` does both)

## Changes${SINCE:+ since $SINCE}

$CHANGES
EOF

echo "Ready in $OUT:"
echo "  $ZIP  sha256 $SHA"
echo "  RELEASE-NOTES.md"
echo "Nothing was published."
