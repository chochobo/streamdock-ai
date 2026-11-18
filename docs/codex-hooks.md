# Codex 세션 상태 훅

Codex의 lifecycle hook을 사용해 세션의 상태 변화를 기록합니다. 이 연동은 관측값을 제공합니다. 모든 Codex 창의 정확한 실시간 상태를 보장하지 않습니다.

## 설치와 검토

```sh
node scripts/install-codex-hook.mjs
```

설치기는 기존 `~/.codex/hooks.json`을 백업하고 StreamDock 훅을 추가합니다. 기존 훅은 유지합니다. 설정이 잘못되었거나 설치 중 변경되면 수정하지 않습니다. 설정을 변경할 때마다 백업 파일을 남깁니다.

Codex는 비관리 훅의 정의를 사용자가 **검토하고 신뢰하기 전까지 실행하지 않습니다.** Codex CLI의 `/hooks`에서 새 훅을 확인하세요. 이 프로젝트는 Codex의 신뢰 검토를 우회하거나 자동 승인하지 않습니다. Desktop 앱과 기존 세션에 언제 적용되는지는 실제로 확인해야 합니다. [OpenAI 공식 훅 문서](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

해제하려면 다음을 실행합니다. StreamDock의 항목만 제거합니다.

```sh
node scripts/install-codex-hook.mjs --remove
```

## 기록과 해석

`~/.cache/streamdock-ai/agents/`에 세션별 기록을 생성합니다. 파일 권한은 0600입니다. 세션 ID, 작업 경로, 프로젝트 이름, 이벤트 종류, 관측 시각, 해시한 턴 식별자와 상태만 저장합니다. 프롬프트, 답변, 도구 입력과 출력은 저장하지 않습니다. 파일은 이 Mac에 남으며 필요하면 삭제할 수 있습니다.

- `UserPromptSubmit`, 해당 턴의 `PreToolUse`, `PostToolUse`: 작업 중 관측.
- `PermissionRequest`: 승인 요청 직전의 이벤트입니다. 다른 훅이 요청을 처리할 수 있으므로 **승인 대기 추정**으로만 사용합니다. 후속 이벤트가 없으면 현재 상태는 알 수 없습니다.
- `Stop`: 다른 Stop 훅이 작업을 계속시킬 수 있으므로 완료로 단정하지 않습니다. 실제 완료는 별도 완료 이벤트로 확인해야 합니다.
- `Interrupt`, `SessionStart`: 세션은 관측됐지만 정확한 작업 상태는 미확인입니다.
- `SessionEnd`: 세션 종료 이벤트를 기록합니다. 갑작스러운 종료에서는 이벤트가 누락될 수 있습니다.

하위 에이전트 훅은 부모 세션 ID를 전달할 수 있습니다. 기록기는 하위 에이전트 식별자가 있는 이벤트를 무시하고, 도구 이벤트는 사용자 요청에서 관측한 턴과 일치할 때만 반영합니다. 환경에 따라 이벤트가 충분히 전달되지 않으면 상태를 미확인으로 남깁니다.
