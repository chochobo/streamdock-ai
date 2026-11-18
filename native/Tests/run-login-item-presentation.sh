#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/streamdock-login-status.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
swiftc -swift-version 5 "$ROOT/native/App/LoginItemPresentation.swift" "$ROOT/native/Tests/LoginItemPresentationTests.swift" -o "$TEMP_DIR/test"
"$TEMP_DIR/test"
