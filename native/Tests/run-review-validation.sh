#!/bin/sh
set -eu
test_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$test_dir/../.." && pwd)
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/streamdock-review-test.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
xcrun swiftc -parse-as-library \
  "$repo_dir/native/App/BackendClient.swift" \
  "$repo_dir/native/App/BackendService.swift" \
  "$repo_dir/native/App/ReviewPanel.swift" \
  "$repo_dir/native/App/ReviewValidation.swift" \
  "$test_dir/ReviewValidationTests.swift" \
  -o "$temp_dir/review-tests"
"$temp_dir/review-tests"
