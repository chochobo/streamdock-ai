# StreamDock AI

Mirabox StreamDock 293S V3에서 Codex와 Claude Code의 세션, 계정 사용량, Mac 상태를 확인하는 macOS 앱입니다. 프로젝트별로 세션을 묶어 표시하며, 키를 눌러 지원되는 채팅이나 터미널을 열 수 있습니다. SwiftUI 설정 창과 기기 미리보기도 제공합니다.

이 프로젝트는 실험 단계입니다. SwiftUI 앱이 Swift HID로 기기에 연결하고, 앱에 포함된 Node.js 백엔드가 기능을 처리합니다. 전체 기능을 Swift로 전환한 상태는 아닙니다.

## 주요 기능

- 프로젝트별 Codex·Claude Code 세션과 작업 상태 표시
- 제공되는 계정 사용률과 리셋 시각 표시
- CPU·메모리·디스크 등 Mac 상태 표시
- 타이머, 주식, 게임, 장면, 워크트리와 선택형 외부 서비스 화면
- SwiftUI 설정과 293S 화면 미리보기

상태를 확인할 근거가 부족하면 `미확인`으로 표시합니다. `?`는 추정한 상태를 뜻합니다. 사용량과 세션 이동은 공급자와 실행 환경에 따라 제한됩니다. 자세한 내용은 [기능 안내](docs/features.md), [사용량 안내](docs/usage.md), [세션 열기 안내](docs/focus.md)를 참고하세요.

## 요구 사항

- macOS 14 이상 및 Xcode의 Swift 컴파일러
- Node.js 22 이상과 npm
- Python 3와 Pillow. 게임과 장면을 사용하며 앱을 빌드할 때도 필요합니다.
- 유효한 코드 서명 신원. Apple Development 신원이 하나면 자동으로 사용합니다. 여러 개이거나 직접 만든 자체 서명 인증서를 쓰려면 지문을 지정해야 합니다. 서명 신원이 없으면 빌드가 중단됩니다.
- 실제 기기를 사용하려면 Mirabox StreamDock 293S V3 (`6603:1014`)와 USB 연결. 다른 모델은 지원하지 않습니다.

앱은 현재 Mac의 Python과 Pillow를 사용합니다. 빌드 후에도 Python 환경을 유지하세요. 서명과 빌드의 상세 조건은 [macOS 앱 안내](docs/native-macos.md)를 참고하세요. 배포용 서명·공증과 다른 Mac에서의 동작은 별도로 확인해야 합니다.

## 설치와 실행

저장소를 내려받고 의존성을 설치합니다. 아래 예시는 홈 디렉터리에 Python 가상 환경을 만듭니다.

```sh
git clone https://github.com/chochobo/streamdock-ai.git
cd streamdock-ai
npm ci
python3 -m venv "$HOME/.venvs/streamdock-ai"
source "$HOME/.venvs/streamdock-ai/bin/activate"
python3 -m pip install Pillow
./scripts/native-build.sh
open build/native/StreamDockAI.app
```

동일한 Python 환경을 활성화한 상태에서 다시 빌드하세요. 기존 StreamDock AI 앱이 실행 중이면 먼저 종료해야 합니다. 여러 서명 신원이 있거나 인증서를 변경해야 한다면 [서명 설정](docs/native-macos.md#빌드)을 확인하세요.

기기를 연결할 때는 공식 StreamDock 앱과 별도로 실행한 StreamDock AI 백엔드를 종료하세요. 앱의 **기기** 또는 **연결과 진단**에서 연결 상태를 확인할 수 있습니다. 프로젝트 키를 누르면 세션 목록이 열립니다. 장면 화면은 실제 기기의 오른쪽 아래 키를 1.2초 이상 눌러 종료합니다.

오른쪽 긴 화면은 현재 표시 전용 세 영역으로 사용합니다. 화면 전체를 하나의 연속된 이미지로 표시하는 방법은 아직 확인하지 못했습니다. 화면·버튼과 재연결은 실제 293S에서 일부 확인했지만 모든 기능과 환경을 검증하지는 않았습니다. 시험 범위는 [기기 검증 기록](docs/device-validation.md)을 참고하세요.

## 권한과 데이터

앱은 로컬 Codex·Claude 세션 기록과 선택적으로 설치한 훅에서 상태와 세션 메타데이터를 읽습니다. 세션 제목은 기기 화면과 로컬 상태 API에 표시될 수 있습니다. 서버는 `127.0.0.1`에서만 요청을 받습니다.

Claude Desktop의 사용량 배지를 읽는 대체 경로에는 macOS **손쉬운 사용** 권한이 필요합니다. 지원되는 터미널 탭을 열 때는 **자동화** 권한이 필요할 수 있습니다. 훅과 사용량 설정 방법 및 제거 방법은 아래 문서에서 확인하세요.

- [Codex 훅](docs/codex-hooks.md) · [Claude 훅](docs/hooks.md) · [Claude 사용량 상태 줄](docs/usage-statusline.md)
- [사용량과 권한](docs/usage.md) · [세션 열기 제한](docs/focus.md)
- [기능별 설정](docs/features.md) · [macOS 앱과 서명](docs/native-macos.md)

## 개발과 테스트

```sh
npm test            # Node 테스트
npm run test:native # Swift 테스트 (macOS)
npm run check       # 둘 다 — PR 전에 돌리는 로컬 게이트
```

이슈·브랜치·PR 흐름은 [작업 흐름](docs/workflow.md)을 따릅니다.

자동 드라이버 테스트는 모의 HID 장치를 사용합니다. 독립 백엔드를 개발할 때는 `npm start`로 실행할 수 있습니다. 기본값은 모의 장치 모드이며, 실행 중인 네이티브 앱과 같은 포트를 사용할 수 없습니다. 종료하려면 `Ctrl+C`를 누르세요.

## 라이선스와 출처

이 프로젝트의 독자적인 코드는 [MIT 라이선스](LICENSE)로 배포합니다. 포함된 외부 코드에는 해당 저작권자의 조건이 적용됩니다.

- [AgentDeck](https://github.com/jakeparkcolde/agentdeck)의 게임과 장면 코드 일부를 포함합니다. 원본의 [저작권 및 MIT 라이선스](src/vendor/agentdeck/LICENSE)와 [출처 및 버전](src/vendor/agentdeck/PROVENANCE.md)을 유지합니다.
- 기기 모델과 프로토콜을 구현할 때 [Mirabox 제조사 SDK](https://github.com/MiraboxSpace/StreamDock-Device-SDK), [mirabox-streamdock-node](https://github.com/rigor789/mirabox-streamdock-node)와 Bitfocus의 293S 모델을 참고했습니다.
- 설치되는 npm 및 Python 의존성에는 각 패키지의 라이선스가 적용됩니다.
