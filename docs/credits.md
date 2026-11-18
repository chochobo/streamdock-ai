# Flow · Higgsfield 크레딧

두 서비스는 기본적으로 꺼져 있습니다. 앱은 사용자가 켜지 않은 서비스를 조회하거나 브라우저를 열지 않습니다. 조회 결과는 서비스가 화면에 표시한 값의 관측치이며, 공식 API의 보증된 응답이 아닙니다. 실제 계정과 크레딧 의미는 각 서비스에서 확인하세요.

## 로컬 값 읽기

`examples/credits.example.json`을 `~/.config/streamdock-ai/credits.json`으로 복사하고 쓰는 서비스만 `enabled: true`로 바꿉니다. `source`는 다음 중 하나입니다.

- `agentdeck-cache`: 기존 AgentDeck이 만든 `~/.cache/d200/flow.json` 또는 `higgsfield.json`을 읽습니다. StreamDock AI가 AgentDeck이나 브라우저를 실행하지는 않습니다.
- `snapshot`: 사용자가 별도로 생성한 `~/.cache/streamdock-ai/credits/flow.json` 또는 `higgsfield.json`을 읽습니다.
- `cdp`: 아래 전용 브라우저의 **이미 열린 탭**을 읽습니다. 이 연결은 명시적으로 켠 경우에만 작동합니다.

snapshot 예시:

```json
{"balance": 120, "total": 500, "checkedAt": "2026-11-09T00:00:00Z", "resetAt": null, "tier": ""}
```

`checkedAt`은 실제 관측 시각이어야 합니다. 3시간이 지나면 `오래됨`으로 표시합니다. AgentDeck 캐시의 리셋 날짜는 AgentDeck이 날짜를 추정할 수 있으므로 `source-estimate`로 표시합니다. 계정 이름, 이메일, 토큰, 쿠키는 결과에 포함하지 않습니다.

## 선택: 전용 브라우저 연결

이 방법은 사이트 화면 구조에 의존합니다. 아직 실제 서비스 계정에서 검증하지 않았습니다. StreamDock AI는 브라우저를 실행하지 않으며 로그인도 하지 않습니다. 일반 Chrome 프로필은 사용하지 않습니다.

1. 사용자가 터미널에서 전용 프로필의 브라우저를 실행합니다.

   ```sh
   mkdir -p "$HOME/.cache/streamdock-ai/credits-browser"
   open -na "Google Chrome" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --user-data-dir="$HOME/.cache/streamdock-ai/credits-browser"
   ```

2. 해당 전용 창에서 사용자가 직접 서비스에 로그인하고, Flow는 계정 메뉴의 크레딧을 펼치거나 Higgsfield는 구독 설정 페이지를 엽니다. 전용 프로필에는 로그인 정보가 저장될 수 있으므로 다른 사람과 공유하지 마세요.
3. 설정 파일에서 원하는 서비스만 다음과 같이 켭니다. 포트는 전용 브라우저와 같아야 합니다.

   ```json
   {"sources":{"flow":{"enabled":true,"source":"cdp","dedicatedProfile":true,"port":9223}}}
   ```

연결 전 macOS 프로세스의 사용자, Chrome 실행 파일, 전용 `--user-data-dir`, 디버그 포트와 루프백 리스닝 주소를 검사합니다. 일치하지 않으면 연결하지 않습니다. 해당 서비스의 이미 열린 탭이 정확히 하나일 때만 사용량에 해당하는 짧은 텍스트를 읽습니다. 앱은 탭을 만들거나 이동·클릭하지 않고 쿠키·토큰·비밀번호를 읽지 않습니다. 화면이 바뀌거나 메뉴가 닫히면 `확인 불가`로 표시됩니다. 브라우저 관측은 최대 30분에 한 번 수행합니다.

Higgsfield 갱신일로부터 크레딧 충전일을 추정하지 않습니다. Flow 화면에 날짜만 있으면 원문을 표시하며 연도를 만들어 넣지 않습니다.
