# 원격 상태와 Antigravity 사용량

원격 기능은 기본적으로 꺼져 있습니다. 앱은 SSH 설정을 찾거나 서버를 자동으로 선택하지 않습니다. 기기에서 조회를 선택하고 Mac 앱의 `요청 검토`에서 표시된 대상과 작업을 확인한 뒤, 기기의 확인 키를 길게 눌렀을 때만 연결합니다.

## 연결 설정

`~/.config/streamdock-ai/remote.json`에 다음 형식으로 직접 작성합니다. 아래 주소는 예시입니다.

```json
{
  "enabled": true,
  "hosts": [
    {
      "label": "작업실",
      "ssh": "user@example.invalid",
      "port": 22,
      "operations": ["machine", "agents", "agy"]
    }
  ]
}
```

`operations`에는 사용할 항목만 넣습니다.

- `machine`: 원격 Python의 운영체제 API로 부하 평균, CPU 개수, 루트 파일시스템의 사용 비율을 읽습니다. 부하 평균은 CPU 사용률이 아닙니다.
- `agents`: 원격의 `herdr-core ls --json`을 실행해 최상위 에이전트 수와 상태를 집계합니다. Herdr가 설치되지 않았거나 형식이 다르면 `확인 불가`입니다. 대화, 터미널 주소와 프로젝트 경로는 화면에 내보내지 않습니다.
- `agy`: 원격의 `agy --version`이 정식 1.1.11 이상일 때만 `agy -p /usage --output-format json`을 실행합니다. 오래된 버전은 `/usage`를 프롬프트로 처리할 수 있어 실행하지 않습니다. 프로그램이 제공한 한도와 리셋 시각만 표시합니다.

주소는 영문 호스트명 또는 IPv4와 선택적 `user@` 형식으로 입력합니다. IPv6 리터럴, 임의 SSH 옵션과 셸 문자는 지원하지 않습니다. 최대 8개 호스트를 설정할 수 있습니다. 비밀번호나 API 키를 이 파일에 적지 마세요.

## SSH 조건

사용자가 미리 확인한 호스트 키가 `~/.ssh/known_hosts`에 있어야 합니다. SSH는 `BatchMode=yes`, `StrictHostKeyChecking=yes`로 실행되며 비밀번호 입력이나 호스트 키 자동 수락을 하지 않습니다. 사용자 SSH 설정의 `ProxyCommand`와 `LocalCommand`를 실행하지 않도록 `-F /dev/null`을 사용합니다. 따라서 SSH 설정의 별칭·점프 호스트·사용자 지정 identity 파일은 적용되지 않습니다. 기본 SSH 키 또는 SSH 에이전트를 사용하세요.

연결은 제한 시간 안에 종료됩니다. 원격 명령은 앱에 포함된 고정 스크립트이며, 설정 문자열을 원격 셸 코드에 끼워 넣지 않습니다. 원격 명령 실패, SSH 권한 문제, 버전 불일치와 응답 형식 오류는 `확인 불가`로 표시합니다. 직전 성공값을 임시로 표시할 때는 `오래됨`으로 구분합니다.

원격 주소, 사용자 이름, 원격 경로와 SSH 출력을 앱 상태 API나 로그에 반환하지 않습니다. 사용자가 입력한 표시 이름, 상태 집계, 관측 시각만 제공합니다. SSH 연결 자체는 대상 서버의 접근 기록에 남을 수 있습니다.

## 제거

사용하지 않으려면 설정의 `enabled`를 `false`로 바꾸거나 설정 파일을 제거합니다. 설정 읽기만으로 네트워크 요청을 보내지 않습니다.

## 구현 인터페이스

`createRemoteProvider().read()`는 네트워크 연결 없이 설정된 표시 이름과 허용된 작업을 반환합니다. `prepare({ id, operation })`는 표시할 대상과 일회성 검토 토큰을 만들며 연결하지 않습니다. `confirm(token)`은 사용자의 검토와 기기 확인을 거친 뒤 대상과 설정을 다시 검증하고 연결합니다. 설정 파일의 선택 항목은 자동 실행을 뜻하지 않습니다.

참고: [AgentDeck Antigravity 구현](https://github.com/jakeparkcolde/agentdeck/blob/main/remote_agy.py), [AgentDeck 원격 에이전트 구현](https://github.com/jakeparkcolde/agentdeck/blob/main/remote_herdr.py).
