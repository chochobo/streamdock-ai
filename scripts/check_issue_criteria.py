#!/usr/bin/env python3
"""PR 이 닫는 이슈에 체크 안 된 완료 조건이 남아 있으면 실패한다.

CI 체크 `issue-criteria` 가 실행한다. PR 본문의 `Closes #N`(close/fix/resolve 계열)
으로 연결한 같은 저장소 이슈를 읽어, 체크 안 된 체크박스(`- [ ] ...`)를 찾는다.

- 하지 못한 항목은 체크하지 않는다. 취소선(`- [ ] ~~항목~~ 이유`)으로 정리하면
  통과한다. 후속 이슈로 옮겼다면 이유에 `→ #M` 을 적는다.
- 코드 블록(```) 안의 체크박스는 예시이므로 세지 않는다.
- 연결 이슈가 없는 PR(chore 등)은 검사할 것이 없으므로 통과한다.

다른 저장소에서도 그대로 쓸 수 있게 표준 라이브러리와 `gh` CLI 만 쓴다.

사용법: python3 scripts/check_issue_criteria.py --pr <PR 번호>
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

_CLOSING_REF = re.compile(
    r"(?<![\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b",
    re.IGNORECASE,
)
_UNCHECKED = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s*(.*)$")
_ANY_CHECKBOX = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]")
_FENCE = re.compile(r"^\s*(```|~~~)")


def linked_issue_numbers(pr_body: str) -> list[int]:
    """PR 본문에서 닫는 키워드로 연결한 같은 저장소 이슈 번호를 순서대로 반환한다.

    `owner/repo#N` 처럼 다른 저장소를 가리키는 참조는 제외한다.
    """
    seen: list[int] = []
    for match in _CLOSING_REF.finditer(pr_body):
        number = int(match.group(1))
        if number not in seen:
            seen.append(number)
    return seen


def _is_cancelled(item: str) -> bool:
    """항목 본문이 취소선으로 시작하면 정리된 항목으로 본다."""
    return item.startswith("~~") and item.count("~~") >= 2


def unchecked_items(issue_body: str) -> list[str]:
    """이슈 본문에서 체크 안 됐고 취소선도 없는 체크박스 항목을 반환한다."""
    items: list[str] = []
    in_fence = False
    for line in issue_body.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = _UNCHECKED.match(line)
        if match and not _is_cancelled(match.group(1).strip()):
            items.append(match.group(1).strip())
    return items


def _gh_json(*args: str) -> dict[str, object]:
    """gh CLI 를 실행해 JSON 결과를 반환한다."""
    output = subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True
    ).stdout
    result: dict[str, object] = json.loads(output)
    return result


def main(argv: list[str] | None = None) -> int:
    """PR 에 연결된 이슈를 검사하고 종료 코드를 반환한다(0 통과, 1 실패)."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pr", required=True, help="검사할 PR 번호")
    args = parser.parse_args(argv)

    pr = _gh_json("pr", "view", args.pr, "--json", "body")
    numbers = linked_issue_numbers(str(pr.get("body") or ""))
    if not numbers:
        print("연결된 이슈(Closes #N)가 없어 검사를 건너뛴다.")
        return 0

    failed = False
    for number in numbers:
        issue = _gh_json("issue", "view", str(number), "--json", "body,title")
        body = str(issue.get("body") or "")
        items = unchecked_items(body)
        if not any(_ANY_CHECKBOX.match(line) for line in body.splitlines()):
            print(f"#{number} 완료 조건 체크박스 없음 — {issue.get('title')}")
            continue
        if not items:
            print(f"#{number} 완료 조건 모두 체크됨 — {issue.get('title')}")
            continue
        failed = True
        print(f"#{number} 체크 안 된 완료 조건 {len(items)}개 — {issue.get('title')}")
        for item in items:
            print(f"  - [ ] {item}")

    if failed:
        print(
            "\n끝낸 항목은 이슈 본문에서 체크한다. 하지 못한 항목은 체크하지 말고 "
            "`- [ ] ~~항목~~ 이유(→ #후속)` 처럼 취소선으로 정리한다. "
            "이슈를 고치면 이 검사가 자동으로 다시 돈다."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
