#!/bin/bash
# Selection only. This script never accesses a private key or changes Keychain.
# Arguments: security(1) output, existing pin, requested fingerprint, allow change.
# stdout contains only the selected SHA-1 fingerprint.
native_select_signing_identity() {
  local listing="$1" pinned="$2" requested="$3" allow_change="$4"
  local line id kind candidate="" count=0 match_re
  local seen=' ' valid=' ' development=''
  match_re='^[[:space:]]*[0-9]+\)[[:space:]]+([[:xdigit:]]{40})[[:space:]]+"(Apple Development|Developer ID Application):'
  while IFS= read -r line; do
    if [[ "$line" =~ $match_re ]]; then
      id="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:lower:]' '[:upper:]')"
      kind="${BASH_REMATCH[2]}"
      case "$seen" in
        *" $id "*) ;;
        *)
          seen="$seen$id "; valid="$valid$id "
          if [[ "$kind" == 'Apple Development' ]]; then
            development="$id"; count=$((count + 1))
          fi
          ;;
      esac
    fi
  done <<< "$listing"
  for candidate in "$pinned" "$requested"; do
    if [[ -n "$candidate" && ! "$candidate" =~ ^[[:xdigit:]]{40}$ ]]; then
      printf '코드 서명 인증서 지문 형식이 올바르지 않습니다.\n' >&2
      return 1
    fi
  done
  pinned="$(printf '%s' "$pinned" | tr '[:lower:]' '[:upper:]')"
  requested="$(printf '%s' "$requested" | tr '[:lower:]' '[:upper:]')"
  if [[ -n "$pinned" && -n "$requested" && "$pinned" != "$requested" && "$allow_change" != 1 ]]; then
    printf '기존 앱과 다른 서명 신원입니다. 변경하려면 명시적으로 허용해야 합니다.\n' >&2
    return 1
  fi
  candidate="${requested:-$pinned}"
  if [[ -z "$candidate" ]]; then
    if [[ "$count" != 1 ]]; then
      printf '유효한 Apple Development 서명 신원을 하나로 정할 수 없습니다. 인증서 지문을 지정하세요.\n' >&2
      return 1
    fi
    candidate="$development"
  fi
  if [[ "$valid" != *" $candidate "* ]]; then
    printf '지정된 유효한 코드 서명 신원을 찾지 못했습니다. 다른 신원으로 자동 변경하지 않습니다.\n' >&2
    return 1
  fi
  printf '%s\n' "$candidate"
}

# Only the existing ad-hoc app can migrate without a prior certificate pin.
# A certificate-signed app with a missing pin is not treated as a fresh install.
native_validate_existing_requirement() {
  local pinned="$1" requirement="$2"
  if [[ -z "$requirement" ]]; then
    printf '기존 앱의 서명 요구조건을 확인하지 못했습니다.\n' >&2
    return 1
  fi
  if [[ -z "$pinned" ]]; then
    if [[ "$requirement" != *'cdhash'* ]]; then
      printf '기존 인증서 서명 앱의 고정 지문이 없습니다. 자동으로 전환하지 않습니다.\n' >&2
      return 1
    fi
  elif [[ "$requirement" == *'cdhash'* || "$requirement" != *'anchor apple generic'* || "$requirement" != *'identifier "local.streamdock.ai"'* ]]; then
    printf '기존 앱의 인증서 서명 요구조건이 올바르지 않습니다.\n' >&2
    return 1
  fi
}
