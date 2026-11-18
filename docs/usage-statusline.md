# Claude Code 사용량 연결

Claude Code가 공식 status line에 전달하는 5시간·7일 사용률과 리셋 시각을 수집합니다. OAuth 토큰이나 API 키는 읽지 않습니다. 기록 파일은 `~/.cache/streamdock-ai/usage/claude-statusline.json`이며 접근 권한은 `0600`입니다. 계정 식별 정보가 없으므로 `계정 미확인`으로 표시합니다.

Claude Code의 status line이 실행될 때만 값이 갱신됩니다. 공식 문서에 따르면 해당 정보는 지원되는 구독 또는 게이트웨이에서 첫 API 응답 이후에만 나타날 수 있습니다. 값이 오래됐거나 없으면 현재 수치로 취급하지 않습니다. [Claude Code status line 문서](https://code.claude.com/docs/en/statusline#rate-limit-usage)

설치하려면 프로젝트 폴더에서 다음 명령을 실행합니다.

```sh
node scripts/install-usage-statusline.mjs
```

설치기는 기존 `~/.claude/settings.json`을 `0600` 백업으로 보관하고, 기존 statusLine 명령 앞에 수집기를 연결합니다. 기존 명령에는 원래 입력이 전달되고 출력과 종료 상태가 유지됩니다. 기존 상태줄의 나머지 설정도 보존합니다. 다른 사용자 또는 프로젝트 설정의 우선순위에 따라 적용되지 않을 수 있습니다.

제거하려면 다음 명령을 실행합니다.

```sh
node scripts/install-usage-statusline.mjs --remove
```

설치 후 statusLine 설정이 변경됐으면 제거기는 변경 사항을 덮어쓰지 않고 중단합니다. 이 경우 현재 설정과 백업을 확인하세요. 설치 정보는 원래 명령을 복원하기 위해 `~/.cache/streamdock-ai/usage-statusline-install.json`에 `0600`으로 저장합니다. 원래 명령에 비밀 값이 포함돼 있다면 이 파일에도 포함됩니다.
