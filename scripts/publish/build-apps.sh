#!/usr/bin/env bash
# Builds a release's app files on this Mac into dist-release/<version>/ of the repo it runs from:
#   - from a fresh clone of HEAD in a temporary folder, so uncommitted files never ship;
#   - the Mac app: stage-server.sh, sign-resources.sh, then `tauri build --bundles app,dmg`, which signs and notarises
#     the app; then the dmg is notarised and stapled, and the app and dmg are checked (codesign, stapler, spctl);
#   - the Windows app: desktop/scripts/build-windows.sh (cross-built, signed with the same updater key);
#   - both with the updater files (`createUpdaterArtifacts`) and RUSTFLAGS="--remap-path-prefix=$HOME=~", so no
#     build path from this Mac's home folder lands in a binary. CARGO_TARGET_DIR is ~/.cache/brainai/target-release,
#     kept between runs;
#   - then it collects BrainAI_<v>_aarch64.dmg, BrainAI_<v>_aarch64.app.tar.gz(.sig), BrainAI_<v>_x64-setup.exe(.sig)
#     and install-app.ps1, and writes latest.json, release-notes.md and SHA256SUMS (src/scripts/releaseManifest.ts).
# Its secrets, never printed: the updater key (~/.config/brainai/updater.key, its password in the Keychain item
# brainai-updater), the first "Developer ID Application" signing identity, APPLE_ID and APPLE_TEAM_ID from
# ~/.config/brainai/release.env, and the app-specific password for notarisation in the Keychain item brainai-notary.
# --ad-hoc is for testing: an ad-hoc ("-") signature, no notarisation, and always a throwaway updater key made for
# the run (never the owner's), into dist-release/<v>-adhoc, which is never uploaded.
# Then check the files: scripts/publish/check-release-files.sh <denylist> dist-release/<v>
# Usage: scripts/publish/build-apps.sh <version> [--ad-hoc]
# Exit 0: built. 1: a build step failed. 2: refused (wrong use, a version unlike tauri.conf.json, a missing tool,
# key, certificate or Keychain item, an output folder that is not empty, or update signatures that do not match the
# updater public key the apps trust).
set -euo pipefail
{ set +x; } 2>/dev/null

VERSION="" ADHOC=0
for arg in "$@"; do
  case "$arg" in
    --ad-hoc) ADHOC=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) if [ -z "$VERSION" ]; then VERSION="$arg"; else echo "Too many arguments" >&2; exit 2; fi ;;
  esac
done
[ -n "$VERSION" ] || { echo "Usage: build-apps.sh <version> [--ad-hoc]" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Give a version like 1.2.3" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Run this inside the git repository to build" >&2; exit 2; }
REPO="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$REPO" rev-parse HEAD)"

CONF_VERSION="$(git -C "$REPO" show HEAD:desktop/src-tauri/tauri.conf.json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).version))')" || CONF_VERSION=""
[ "$VERSION" = "$CONF_VERSION" ] || { echo "The version $VERSION is not the one in desktop/src-tauri/tauri.conf.json at HEAD (${CONF_VERSION:-none}): set it there and commit first" >&2; exit 2; }
HAS_NOTES=1
git -C "$REPO" show HEAD:CHANGELOG.md 2>/dev/null | grep -E "^## ${VERSION//./\\.}( |$)" >/dev/null || HAS_NOTES=0
[ "$HAS_NOTES" = 1 ] || [ "$ADHOC" = 1 ] || { echo "CHANGELOG.md at HEAD has no \"## $VERSION\" section: the release notes come from it" >&2; exit 2; }

CONFIG_DIR="$HOME/.config/brainai"
# The secrets: read into unexported shell variables, so no npm install script or staging step ever sees them; they
# are handed only to the two `tauri build` lines below. Nothing prints them. Any inherited from the caller's shell
# are dropped first.
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE \
  APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
if [ "$ADHOC" = 1 ]; then
  APPLE_SIGNING_IDENTITY="-"
else
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)" || true
  [ -n "$APPLE_SIGNING_IDENTITY" ] || { echo "There is no \"Developer ID Application\" certificate in the Keychain: other Macs only open an app signed with one (use --ad-hoc for a test build)." >&2; exit 2; }
  [ -r "$CONFIG_DIR/release.env" ] || { echo "There is no ~/.config/brainai/release.env with APPLE_ID and APPLE_TEAM_ID: notarisation needs the Apple account." >&2; exit 2; }
  env_value() { sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" "$CONFIG_DIR/release.env" | tail -1 | tr -d '\r' | sed -e "s/^[\"']//" -e "s/[\"'][[:space:]]*$//" -e 's/[[:space:]]*$//'; }
  APPLE_ID="$(env_value APPLE_ID)"; APPLE_TEAM_ID="$(env_value APPLE_TEAM_ID)"
  [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] || { echo "~/.config/brainai/release.env needs both APPLE_ID and APPLE_TEAM_ID." >&2; exit 2; }
  APPLE_PASSWORD="$(security find-generic-password -s brainai-notary -w 2>/dev/null)" || APPLE_PASSWORD=""
  [ -n "$APPLE_PASSWORD" ] || { echo "There is no notarisation password in the Keychain item brainai-notary (an app-specific password for the Apple account)." >&2; exit 2; }
  [ -f "$CONFIG_DIR/updater.key" ] && [ -r "$CONFIG_DIR/updater.key" ] || { echo "There is no updater key at ~/.config/brainai/updater.key: the updates are signed with it." >&2; exit 2; }
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s brainai-updater -w 2>/dev/null)" || TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  [ -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ] || { echo "There is no updater key password in the Keychain item brainai-updater." >&2; exit 2; }
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$CONFIG_DIR/updater.key")"
fi

OUT="$REPO/dist-release/$VERSION"
[ "$ADHOC" = 1 ] && OUT="$REPO/dist-release/$VERSION-adhoc"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then echo "$OUT is not empty: move or delete it first" >&2; exit 2; fi
# The files are collected in <out>.partial and moved to <out> as the last step, so <out> only ever holds a whole
# release. A .partial is what a failed run left: it is removed.
PART="$OUT.partial"
if [ -e "$PART" ]; then echo "Removing $PART, left by an earlier run that did not finish."; rm -rf "$PART"; fi

export PATH="$HOME/.cargo/bin:$PATH"
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1: $2" >&2; exit 2; }; }
need npm "Node 22"
need npx "Node 22"
need cargo "rustup (https://rustup.rs)"
need rustup "rustup (https://rustup.rs)"
need cargo-xwin "cargo install --locked cargo-xwin"
need makensis "brew install nsis"
need cabextract "brew install cabextract"
need hdiutil "a Mac"
need codesign "the Xcode command line tools"
need xcrun "the Xcode command line tools"
need shasum "a Mac"
rustup target list --installed 2>/dev/null | grep -qx x86_64-pc-windows-msvc || { echo "Missing the Rust target: rustup target add x86_64-pc-windows-msvc" >&2; exit 2; }
[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Build the release on an Apple-silicon Mac" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ -n "$(git -C "$REPO" status --porcelain)" ] && echo "Note: uncommitted changes are not in the build (it is HEAD, $SHA)."

echo "Cloning HEAD ($SHA) ..."
SRC="$WORK/src"
git clone -q "$REPO" "$SRC"
git -C "$SRC" -c advice.detachedHead=false checkout -q --detach "$SHA"
if [ "$HAS_NOTES" = 0 ]; then
  # Only for --ad-hoc: a test build of a version with no notes yet gets a placeholder, in the clone only.
  printf '\n## %s\n\nA test build.\n' "$VERSION" >> "$SRC/CHANGELOG.md"
fi

export CARGO_TARGET_DIR="$HOME/.cache/brainai/target-release"
export RUSTFLAGS="--remap-path-prefix=$HOME=~"
mkdir -p "$CARGO_TARGET_DIR"
UPDATER_CONFIG='{"bundle":{"createUpdaterArtifacts":true}}'
# No bundle from an earlier run may be collected by mistake.
rm -rf "$CARGO_TARGET_DIR/release/bundle" "$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle"

echo "Installing the build tools ..."
(cd "$SRC" && npm ci --no-audit --no-fund >/dev/null)
(cd "$SRC/desktop" && npm ci --no-audit --no-fund >/dev/null)

if [ "$ADHOC" = 1 ]; then
  echo "Making a throwaway updater key for this test build ..."
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  (cd "$SRC/desktop" && npx tauri signer generate --ci -p "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" -w "$WORK/k" >/dev/null 2>&1) || { echo "Could not make a throwaway updater key" >&2; exit 1; }
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$WORK/k")"
fi
# The public key the update signatures must match: the one the apps trust, or the throwaway one of a test build.
TRUSTED_KEY="$SRC/desktop/src-tauri/tauri.conf.json"
[ "$ADHOC" = 1 ] && TRUSTED_KEY="$WORK/k.pub"

echo "Building the Mac app ..."
"$SRC/desktop/scripts/stage-server.sh"
"$SRC/desktop/scripts/sign-resources.sh" "$APPLE_SIGNING_IDENTITY"
# CI=true: Tauri then makes the dmg without the Finder layout script, which needs control of Finder (an AppleEvent
# that times out from a terminal without that permission, or over ssh). The dmg still holds the app and the
# Applications link.
# The secrets are exported in this subshell only, for Tauri: the Apple ones only for a real build (an empty APPLE_ID
# would still ask Tauri to notarise).
(
  export APPLE_SIGNING_IDENTITY TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  if [ "$ADHOC" = 0 ]; then export APPLE_ID APPLE_TEAM_ID APPLE_PASSWORD; fi
  cd "$SRC/desktop" && CI=true npx tauri build --bundles app,dmg --config "$UPDATER_CONFIG"
)
BUNDLE="$CARGO_TARGET_DIR/release/bundle"
APP="$BUNDLE/macos/BrainAI.app"
DMG="$BUNDLE/dmg/BrainAI_${VERSION}_aarch64.dmg"
for f in "$APP" "$DMG" "$BUNDLE/macos/BrainAI.app.tar.gz" "$BUNDLE/macos/BrainAI.app.tar.gz.sig"; do
  [ -e "$f" ] || { echo "The Mac build made no $(basename "$f")" >&2; exit 1; }
done
# Before notarising: a build that crashes at start fails here, without waiting for Apple. From a logged-in desktop
# session only (the window must reach the screen).
echo "Launching the Mac app once (a throwaway home folder) ..."
"$SRC/desktop/scripts/smoke-launch-mac.sh" "$APP" 25 || { echo "The Mac app does not stay up after starting: not releasing it" >&2; exit 1; }

if [ "$ADHOC" = 0 ]; then
  echo "Notarising the dmg ..."
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD" --wait > "$WORK/notary.log" 2>&1 || true
  grep -q 'status: Accepted' "$WORK/notary.log" || { grep -vi 'password' "$WORK/notary.log" | tail -20 >&2; echo "Apple did not accept the dmg (see xcrun notarytool log <id>)" >&2; exit 1; }
  xcrun stapler staple "$DMG"
fi

echo "Checking the Mac app ..."
codesign --verify --deep --strict --verbose=2 "$APP" || { echo "The app's signature does not verify" >&2; exit 1; }
if [ "$ADHOC" = 0 ]; then
  xcrun stapler validate "$APP" || { echo "The app has no notarisation ticket" >&2; exit 1; }
  xcrun stapler validate "$DMG" || { echo "The dmg has no notarisation ticket" >&2; exit 1; }
  spctl -a -t open --context context:primary-signature -v "$DMG" || { echo "Gatekeeper refuses the dmg" >&2; exit 1; }
fi

echo "Building the Windows app ..."
# Only the updater key, never the Apple secrets; build-windows.sh hands it to its `tauri build` line alone.
TAURI_SIGNING_PRIVATE_KEY="$TAURI_SIGNING_PRIVATE_KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
  "$SRC/desktop/scripts/build-windows.sh" --config "$UPDATER_CONFIG"
SETUP="$SRC/dist-windows/BrainAI_${VERSION}_x64-setup.exe"
for f in "$SETUP" "$SETUP.sig"; do [ -f "$f" ] || { echo "The Windows build made no $(basename "$f")" >&2; exit 1; }; done

echo "Collecting the release files ..."
mkdir -p "$PART"
cp "$DMG" "$PART/BrainAI_${VERSION}_aarch64.dmg"
cp "$BUNDLE/macos/BrainAI.app.tar.gz" "$PART/BrainAI_${VERSION}_aarch64.app.tar.gz"
cp "$BUNDLE/macos/BrainAI.app.tar.gz.sig" "$PART/BrainAI_${VERSION}_aarch64.app.tar.gz.sig"
cp "$SETUP" "$SETUP.sig" "$PART/"
cp "$SRC/scripts/windows/install-app.ps1" "$PART/"
# A wrong ~/.config/brainai/updater.key would publish an update no installed app accepts: refuse it.
(cd "$SRC" && node --import tsx src/scripts/updaterKey.ts "$TRUSTED_KEY" "$PART/"*.sig) || { echo "The update signatures do not match the updater public key in tauri.conf.json: check ~/.config/brainai/updater.key" >&2; exit 2; }
(cd "$SRC" && node --import tsx src/scripts/releaseManifest.ts "$VERSION" "$PART" --changelog "$SRC/CHANGELOG.md")
rm -rf "$OUT"
mv "$PART" "$OUT"

echo "Built BrainAI $VERSION$([ "$ADHOC" = 1 ] && echo ' (ad-hoc test build, never to upload)'):"
(cd "$OUT" && ls -l)
echo "Now check it: scripts/publish/check-release-files.sh <denylist> $OUT"
