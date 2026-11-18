# 로그인 시 실행 계획

이 도구는 **검토용 plist만 생성**합니다. 자동 실행을 설치하거나 `launchctl`을 호출하지 않습니다. 시스템 전체 서비스가 아닌 현재 사용자용 LaunchAgent를 대상으로 합니다.

1. 검토 파일을 놓을 디렉터리를 준비합니다. 사용자 또는 시스템 `LaunchAgents` 폴더는 검토 파일 위치로 사용할 수 없습니다.
2. 예를 들어 프로젝트 폴더에 실제 장치 모드의 검토 파일을 만듭니다. 첫 줄의 경로는 프로젝트를 내려받은 위치로 바꾸세요.

```sh
cd /path/to/streamdock-ai
node scripts/launchd-plan.mjs --device --write "$PWD/streamdock-review.plist"
```

`--device`를 빼면 미리보기 모드입니다. `--port 4174`로 포트를 지정할 수 있습니다. 생성기는 기존 파일을 덮어쓰지 않습니다. `--keep-alive`는 실패할 때 재시작을 요청하므로, 기본값은 꺼져 있습니다.

3. 생성된 plist의 Node 경로, 프로젝트 폴더, 포트와 `--device` 여부를 검토합니다. 설치하기 전에 같은 포트의 기존 StreamDock AI를 종료합니다. 장치 모드라면 공식 StreamDock 앱도 종료합니다.
4. 생성기가 출력한 명령을 확인한 뒤 사용자가 직접 실행합니다. 이 명령은 같은 이름의 기존 plist를 덮어쓰지 않고, 검토 파일과 설치 파일이 일치할 때만 `launchctl bootstrap`을 실행합니다.

설치하면 다음 로그인부터 해당 사용자 세션에서 실행됩니다. Claude Desktop 사용량 관측은 LaunchAgent가 실행되는 환경의 macOS 접근성 권한과 Claude 화면 상태에 따라 달라집니다. 네이티브 앱은 자체 백엔드를 사용하므로, 같은 포트나 장치를 쓰는 이 독립 실행 백엔드와 동시에 실행하지 마세요.

자동 실행을 해제하려면 사용자가 `launchctl bootout gui/사용자ID/local.streamdock-ai`로 내리고, 해당 plist를 직접 확인해 제거해야 합니다. 이는 화면의 내용이나 Claude·Codex 설정을 삭제하지 않습니다.

[Apple의 LaunchAgent 설명](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
