#!/bin/bash
set -euo pipefail

# Build a local, transitional macOS app. The current Node engine is copied
# into the bundle; user configuration, hooks, caches and sessions are not.
workspace="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=native-signing.sh
source "$workspace/scripts/native-signing.sh"
case "${1:-}" in
  '') stage_only=0 ;;
  --stage-only) stage_only=1 ;;
  *) printf '사용법: scripts/native-build.sh [--stage-only]\n' >&2; exit 2 ;;
esac
[[ "$#" -le 1 ]] || { printf '사용법: scripts/native-build.sh [--stage-only]\n' >&2; exit 2; }
build_root="$workspace/build/native"
destination="$build_root/StreamDockAI.app"
node_bin="$(command -v node || true)"
python_bin="$(command -v python3 || true)"
codex_bin="$(command -v codex || true)"

# Replacing a bundle while its Node child is alive can mix old and new files.
# Leave the existing app and device untouched; the user can quit it first.
if [[ "$stage_only" == 0 ]] && { /usr/bin/pgrep -f "$destination/Contents/MacOS/StreamDockAI" >/dev/null 2>&1 || \
   /usr/bin/pgrep -f "$destination/Contents/Resources/runtime/node" >/dev/null 2>&1; }; then
  printf '빌드된 StreamDock AI가 실행 중입니다. 앱을 종료한 뒤 다시 빌드하세요.\n' >&2
  exit 1
fi

if [[ -z "$node_bin" || -z "$python_bin" ]]; then
  printf 'Node 22 이상과 Python 3가 필요합니다.\n' >&2
  exit 1
fi
if ! "$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' ; then
  printf 'Node 22 이상이 필요합니다.\n' >&2
  exit 1
fi
if ! (cd "$workspace" && "$node_bin" --input-type=module -e "await import('node-hid'); await import('sharp')"); then
  printf '현재 Mac에서 node-hid 또는 sharp를 불러오지 못했습니다.\n' >&2
  exit 1
fi
if ! "$python_bin" -c 'import PIL' >/dev/null 2>&1; then
  printf '게임과 화면보호기에 필요한 Python Pillow를 찾을 수 없습니다.\n' >&2
  exit 1
fi
if ! command -v swiftc >/dev/null; then
  printf 'Swift 컴파일러를 찾을 수 없습니다. Xcode 설정을 확인하세요.\n' >&2
  exit 1
fi

# Pin the signing certificate in the existing bundle. Never silently change
# identity or fall back to ad-hoc signing: either would break TCC continuity.
pinned_identity=""
old_requirement=""
if [[ -e "$destination" ]]; then
  if [[ ! -f "$destination/Contents/Info.plist" ]]; then
    printf '기존 앱 서명을 확인하지 못했습니다. 기존 앱은 변경하지 않았습니다.\n' >&2
    exit 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict "$destination" >/dev/null 2>&1; then
    # An app that ran before #43 is only accepted if nothing but Python bytecode changed.
    verify_output="$(/usr/bin/codesign --verify --deep --strict --verbose=4 "$destination" 2>&1 || true)"
    if ! native_only_bytecode_failed "$verify_output"; then
      printf '기존 앱 서명을 확인하지 못했습니다. 기존 앱은 변경하지 않았습니다.\n' >&2
      exit 1
    fi
    printf '기존 앱의 Python 바이트코드만 달라져 있습니다. 새로 빌드하면서 교체합니다.\n' >&2
  fi
  existing_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_bundle_id" != 'local.streamdock.ai' ]]; then
    printf '기존 앱의 식별자가 일치하지 않습니다. 기존 앱은 변경하지 않았습니다.\n' >&2
    exit 1
  fi
  pinned_identity="$(/usr/libexec/PlistBuddy -c 'Print :StreamDockSigningIdentity' "$destination/Contents/Info.plist" 2>/dev/null || true)"
  # codesign reports the implicit ad-hoc requirement as '# designated =>'.
  old_requirement="$(/usr/bin/codesign --display --requirements - "$destination" 2>&1 | sed -n -E 's/^#?[[:space:]]*designated => //p')"
  native_validate_existing_requirement "$pinned_identity" "$old_requirement"
  # The only unpinned migration accepted above is the existing ad-hoc build.
  if [[ -z "$pinned_identity" ]]; then old_requirement=""; fi
fi
if ! identities="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null)"; then
  printf '코드 서명 신원을 확인하지 못했습니다. 키체인 상태를 확인하세요.\n' >&2
  exit 1
fi
signing_identity="$(native_select_signing_identity "$identities" "$pinned_identity" "${STREAMDOCK_SIGN_IDENTITY:-}" "${STREAMDOCK_ALLOW_SIGNING_IDENTITY_CHANGE:-0}")"

mkdir -p "$build_root"
stage="$(mktemp -d "$build_root/.stage.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
app="$stage/StreamDockAI.app"
contents="$app/Contents"
resources="$contents/Resources"
mkdir -p "$contents/MacOS" "$resources/runtime" "$resources/backend"

cp "$node_bin" "$resources/runtime/node"
cp "$workspace/package.json" "$resources/backend/package.json"
cp -R "$workspace/src" "$resources/backend/src"
cp -R "$workspace/scripts" "$resources/backend/scripts"
# The workspace may hold __pycache__ from local runs. Python rewrites them when the app
# runs, which would break the signature, so they are never part of the signed bundle (#43).
/usr/bin/find "$resources/backend/src" "$resources/backend/scripts" \( -type d -o -type l \) -name __pycache__ -prune -exec /bin/rm -rf {} +
cp -R "$workspace/node_modules" "$resources/backend/node_modules"
{
  dirname "$python_bin"
  if [[ -n "$codex_bin" ]]; then dirname "$codex_bin"; fi
} > "$resources/runtime/paths.txt"

cat > "$contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>StreamDockAI</string>
  <key>CFBundleIdentifier</key><string>local.streamdock.ai</string>
  <key>CFBundleName</key><string>StreamDock AI</string>
  <key>CFBundleDisplayName</key><string>StreamDock AI</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>선택한 에이전트 세션을 열기 위해 다른 앱을 제어합니다.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
/usr/libexec/PlistBuddy -c "Add :StreamDockSigningIdentity string $signing_identity" "$contents/Info.plist"

sources=("$workspace"/native/App/*.swift)
if [[ ! -f "${sources[0]}" ]]; then
  printf 'Swift 앱 소스를 찾을 수 없습니다.\n' >&2
  exit 1
fi
swiftc -parse-as-library -O -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" -o "$contents/MacOS/StreamDockAI" \
  -framework SwiftUI -framework AppKit -framework Security
if [[ -f "$workspace/native/HID/Package.swift" ]]; then
  swift build --package-path "$workspace/native/HID" --scratch-path "$stage/hid-build" -c release
  hid_bin_dir="$(swift build --package-path "$workspace/native/HID" --scratch-path "$stage/hid-build" -c release --show-bin-path)"
  cp "$hid_bin_dir/streamdock-hid" "$resources/runtime/streamdock-hid"
  /usr/bin/codesign --force --timestamp=none --sign "$signing_identity" "$resources/runtime/streamdock-hid" >/dev/null
fi
/usr/bin/codesign --force --deep --timestamp=none --sign "$signing_identity" "$app" >/dev/null
/usr/bin/codesign --verify --deep --strict "$app"
requirement="$(/usr/bin/codesign --display --requirements - "$app" 2>&1)"
if ! native_requirement_is_stable "$requirement" "$signing_identity"; then
  printf '안정적인 앱 서명 요구조건을 확인하지 못했습니다. 기존 앱은 변경하지 않았습니다.\n' >&2
  exit 1
fi
new_requirement="$(printf '%s\n' "$requirement" | sed -n 's/^designated => //p')"
if [[ -n "$old_requirement" && "${STREAMDOCK_ALLOW_SIGNING_IDENTITY_CHANGE:-0}" != 1 && "$old_requirement" != "$new_requirement" ]]; then
  printf '기존 앱과 서명 요구조건이 달라 기존 앱을 유지합니다.\n' >&2
  exit 1
fi

if [[ "$stage_only" == 1 ]]; then
  rm -rf "$stage/hid-build"
  trap - EXIT
  printf '검토용 앱: %s\n' "$app"
  exit 0
fi

# Keep any previously built bundle as a dated backup. Never remove user data.
if /usr/bin/pgrep -f "$destination/Contents/MacOS/StreamDockAI" >/dev/null 2>&1 || \
   /usr/bin/pgrep -f "$destination/Contents/Resources/runtime/node" >/dev/null 2>&1; then
  printf '빌드 중 앱이 실행됐습니다. 앱을 종료한 뒤 다시 빌드하세요.\n' >&2
  exit 1
fi
if [[ -e "$destination" ]]; then
  # A non-.app suffix avoids advertising multiple bundles with the same ID to LaunchServices.
  backup="$build_root/StreamDockAI.previous.$(date +%Y%m%d%H%M%S).$$.backup"
  mv "$destination" "$backup"
  printf '이전 앱 보관: %s\n' "$backup"
fi
mv "$app" "$destination"
printf '빌드 완료: %s\n' "$destination"
printf '게임·화면보호기는 이 Mac의 Python/Pillow를 사용합니다.\n'
