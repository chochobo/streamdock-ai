# 에이전트 상태 연결

앱은 `~/.cache/streamdock-ai/agents/`의 상태 파일과 기존 [AgentDeck](https://github.com/jakeparkcolde/agentdeck)의 `~/.cache/d200/agents/` 파일을 읽습니다. Codex와 Claude의 로컬 세션 기록도 읽어 프로젝트와 세션 목록을 구성합니다. 기록에 있는 세션이 현재 실행 중이라는 뜻은 아닙니다.

## Claude Code 훅 설치와 해제

이 Mac에는 StreamDock AI 훅을 설치 스크립트로 추가했습니다. 기존 Claude 설정과 다른 훅은 유지합니다. 추가 설치가 필요한 경우 프로젝트 폴더에서 실행하세요.

```sh
node scripts/install-claude-hook.mjs
```

기존 `~/.claude/settings.json`이 있으면 변경 전 같은 디렉터리에 `settings.json.streamdock-backup-<시각>` 형식으로 백업합니다. 명령을 다시 실행해도 같은 훅을 중복 추가하지 않습니다. 잘못된 설정 형식은 덮어쓰지 않고 오류로 표시합니다. 추가한 항목만 제거하려면 다음을 실행하세요.

```sh
node scripts/install-claude-hook.mjs --remove
```

제거 전에도 현재 설정을 백업합니다. 전체 백업 파일로 복원하면 그 뒤 추가한 다른 설정도 바뀔 수 있으므로 주의하세요. 훅 적용 여부는 새 Claude Code 세션에서 확인하세요.

[Claude Code 훅 문서](https://code.claude.com/docs/en/hooks)에 따라 작업, 승인 요청, 완료, 종료 등의 이벤트를 수집합니다. 훅을 받지 못하거나 긴 작업에서 이벤트가 없으면 상태가 오래될 수 있습니다. 오래된 상태는 종료로 단정하지 않고 `미확인`으로 표시합니다. 기존 기록에서 찾은 세션은 훅이 없을 때 `미확인`일 수 있습니다.

## Codex

Codex의 로컬 세션 기록에서 작업 시작과 완료를 추정합니다. 기록은 공식 실시간 상태 API가 아니며 승인 대기는 확인하지 못합니다. 화면의 `?`는 추정을 뜻합니다. 앱은 `~/.codex/config.toml`을 자동으로 수정하지 않습니다.

선택적으로 완료 알림을 기록하려면 `~/.codex/config.toml`을 백업하고, 최상위에 기존 `notify`가 없는 경우에만 다음을 추가하세요. 경로는 프로젝트의 실제 절대 경로로 바꾸세요.

```toml
notify = ["python3", "/ABSOLUTE/PATH/streamdock-ai/scripts/agent-hook.py", "codex"]
```

기존 `notify`가 있으면 두 개를 추가하지 마세요. 기존 명령과 인자를 `"--"` 뒤에 넣어 하나로 합칠 수 있습니다. 예를 들어 기존 값이 `["/path/to/old-notify", "--option"]`이면 다음과 같습니다.

```toml
notify = ["python3", "/ABSOLUTE/PATH/streamdock-ai/scripts/agent-hook.py", "codex", "--", "/path/to/old-notify", "--option"]
```

기존 명령은 같은 알림 JSON을 받지만 백그라운드에서 실행되므로 순서나 종료 코드에 의존하는 연동은 먼저 확인하세요. [OpenAI 공식 문서](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)의 `notify`는 턴 완료 이벤트를 전달합니다. 이 방식만으로는 작업 중 또는 승인 대기를 알 수 없고 데스크톱의 모든 세션에 적용되는지도 검증하지 않았습니다. 해제할 때는 추가한 `notify`를 제거하거나 백업한 기존 값으로 되돌리세요.

## 저장 정보와 세션 이동

훅은 상태, 프로젝트, 갱신 시각을 기록합니다. 세션 이동에 필요한 원본 세션 ID와 절대 작업 경로, 선택적으로 프로세스 ID·시작 시각·TTY·앱 식별자도 로컬 상태 파일에 저장됩니다. 새 상태 파일은 소유자만 읽고 쓸 수 있도록 `0600`으로 만듭니다. 앱은 그 원본 값들을 웹 상태 API로 반환하지 않습니다. 프롬프트와 답변 본문은 훅 상태 파일에 저장하지 않습니다. 세션 제목은 화면에 표시될 수 있으므로 화면 공유 시 주의하세요. 상태 파일은 필요하면 `~/.cache/streamdock-ai/agents/`에서 수동으로 삭제할 수 있습니다.

세션 버튼의 정확한 이동 지원과 검증 범위는 [세션 열기 안내](focus.md)를 확인하세요. 데스크톱 딥링크 형식은 설치된 앱 구현에서 확인했으며 공개된 안정 API로 검증하지 않았습니다. 요청 전송만으로 실제 채팅 전환을 보장하지 않습니다.
