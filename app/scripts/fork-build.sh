#!/bin/sh
# Fork: build a signed Yogurt.app for this Mac, with auto-update turned off.
#   sh app/scripts/fork-build.sh            # from anywhere in the repo
#   sh app/scripts/fork-build.sh --clean    # also rebuild whisper-server from scratch (after an Xcode/macOS update)
# Output: app/dist/mac-arm64/Yogurt.app and app/dist/Yogurt-mac-arm64.dmg. Copy either one to the Mac that runs
# Yogurt, quit Yogurt there, and replace the old app. Settings, meetings and permissions carry over.
#
# Why each piece is here:
# - yogurtPreview=true: without it the app updates itself from FrigadeHQ's releases and loses the fork's changes.
# - SDKROOT/CC/CXX: the Command Line Tools SDK can be newer than Xcode's linker, and whisper.cpp's link then fails
#   with "tapi error: malformed file ... unknown architecture". Xcode's own SDK and compilers avoid it.
# - notarize=false: a build for this Mac only; signing with your Developer ID keeps permissions (Accessibility,
#   mic, screen recording) attached to the same app identity from one build to the next.
# Needs: Xcode, cmake (brew install cmake), pnpm install done once at the repo root.
set -e
ID="${YOGURT_SIGN_ID:-Don Browning (YR2B55YA56)}"
cd "$(dirname "$0")/.."

if [ "$1" = --clean ]; then rm -rf native/.whisper-build/build; fi

SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
CC=$(xcrun -f clang)
CXX=$(xcrun -f clang++)
export SDKROOT CC CXX
sh scripts/native.sh

npx electron-vite build
CSC_NAME="$ID" npx electron-builder --mac --publish never \
  -c.extraMetadata.yogurtPreview=true -c.mac.notarize=false

APP=dist/mac-arm64/Yogurt.app
codesign --verify --deep --strict "$APP"
# the auto-update switch made it into the app: refuse to hand over a build that would replace itself
node -e '
  const p = JSON.parse(require("@electron/asar").extractFile(process.argv[1], "package.json").toString())
  if (p.yogurtPreview !== true) { console.error("yogurtPreview is missing: this build would auto-update to upstream"); process.exit(1) }
' "$APP/Contents/Resources/app.asar"

echo
echo "Built $(pwd)/$APP ($(node -p 'require("./package.json").version'), auto-update off)"
