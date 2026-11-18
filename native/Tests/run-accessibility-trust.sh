#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/streamdock-ax-test.XXXXXXXX")"
trap 'rm -rf "$tmp"' EXIT
swiftc -swift-version 5 -parse-as-library "$root/native/App/AccessibilityTrust.swift" "$root/native/Tests/AccessibilityTrustTests.swift" -o "$tmp/accessibility-test"
"$tmp/accessibility-test"
