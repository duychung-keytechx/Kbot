#!/usr/bin/env bash
# Builds the macOS installer: Kbot.app packed into a drag-to-Applications .dmg.
#
#   scripts/build.sh                    # this Mac's architecture
#   scripts/build.sh --arch universal   # one .dmg for Apple Silicon and Intel
#   scripts/build.sh --arch x86_64      # Intel only
#
# The .dmg is copied to release/.
#
# Signing (read by the Tauri bundler from the environment):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: ..." to sign for
#                            distribution. Defaults to "-" (ad-hoc), which runs
#                            on this Mac; on other Macs users must allow it in
#                            System Settings > Privacy & Security the first time.
#   APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID
#                            set all three to also notarize the app.
set -euo pipefail

cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 1; }

arch="$(uname -m)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) arch="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

case "$arch" in
  arm64|aarch64) target="aarch64-apple-darwin"; rust_targets=(aarch64-apple-darwin) ;;
  x86_64)        target="x86_64-apple-darwin";  rust_targets=(x86_64-apple-darwin) ;;
  universal)     target="universal-apple-darwin"
                 rust_targets=(aarch64-apple-darwin x86_64-apple-darwin) ;;
  *) die "--arch must be arm64, x86_64 or universal" ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || die "the macOS installer can only be built on macOS"
for tool in node npm cargo rustup; do
  command -v "$tool" >/dev/null || die "$tool not found (see Getting started in README.md)"
done

installed="$(rustup target list --installed)"
for t in "${rust_targets[@]}"; do
  grep -qx "$t" <<<"$installed" || rustup target add "$t"
done

if [[ ! -d node_modules ]]; then
  npm ci
fi

export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
if [[ "$APPLE_SIGNING_IDENTITY" == "-" ]]; then
  echo "Signing ad-hoc (set APPLE_SIGNING_IDENTITY to sign with a Developer ID)."
fi
if [[ -n "${APPLE_ID:-}" && ( -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ) ]]; then
  die "notarizing needs APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID together"
fi

npx tauri build --target "$target" --bundles app,dmg --ci

version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
bundle_dir="src-tauri/target/$target/release/bundle"
dmg="$(ls -t "$bundle_dir"/dmg/*.dmg | head -n 1)"
[[ -f "$dmg" ]] || die "no .dmg found in $bundle_dir/dmg"

mkdir -p release
suffix="${arch/aarch64/arm64}"
out="release/Kbot_${version}_${suffix}.dmg"
cp "$dmg" "$out"

echo
echo "Installer: $out"
echo "App:       $bundle_dir/macos/Kbot.app"
