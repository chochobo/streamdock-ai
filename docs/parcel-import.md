# AliExpress 운송장 가져오기

이 기능은 기본적으로 꺼져 있습니다. 로그인 정보와 쿠키를 읽거나 내보내지 않습니다. 일반 Chrome 프로필은 사용하지 않습니다. **사용자가 전용 브라우저에서 직접 로그인하고 직접 열어 둔 배송 추적 탭**만 읽습니다.

## 설정

앱 폴더에서 안전한 기본 예제를 복사하세요.

```sh
mkdir -p "$HOME/.config/streamdock-ai"
cp examples/parcel-import.example.json "$HOME/.config/streamdock-ai/parcel-import.json"
chmod 600 "$HOME/.config/streamdock-ai/parcel-import.json"
```

직접 사용할 때만 파일의 `enabled`와 `dedicatedProfile`을 `true`로 바꾸세요. `port`는 1024~65535 범위의 사용하지 않는 로컬 포트여야 합니다.

## 전용 브라우저

예제 포트 9333을 쓰는 경우, Google Chrome을 전용 프로필로 직접 실행합니다.

```sh
mkdir -p "$HOME/.cache/streamdock-ai/parcel-browser"
open -na "Google Chrome" --args --user-data-dir="$HOME/.cache/streamdock-ai/parcel-browser" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333 --no-first-run --no-default-browser-check
```

이 창에서 직접 AliExpress에 로그인하고 가져오려는 주문의 **배송 추적 페이지**를 여세요. 앱은 로그인·인증·주문 버튼 클릭·페이지 이동·탭 생성을 하지 않습니다. 열린 `https://www.aliexpress.com/p/tracking/index.html` 페이지에서 `운송장 번호` 또는 `Tracking number`처럼 명시된 값만 최대 40개 읽습니다. 최대 8개 탭을 확인합니다. 화면에 번호가 없으면 가져오지 못합니다.

디버깅 포트는 로컬 프로그램이 전용 브라우저를 제어할 수 있는 통로입니다. 가져오기 후에는 전용 Chrome을 종료하세요. 앱은 실제 리스너가 localhost에만 열렸는지, 현재 사용자의 승인된 Chrome 실행 파일과 전용 프로필인지 확인합니다. 확인하지 못하면 읽기를 중단합니다.

## 검토와 적용

293S의 `택배` 화면에서 `알리 가져오기`를 선택하면 미리보기를 준비합니다. **Mac 앱의 `요청 검토`에서 운송장 전체를 확인하고 가져올 항목을 선택**한 뒤 명시적으로 적용해야 로컬 택배 설정에 추가됩니다. 미리보기와 적용 사이 설정이나 택배 파일이 바뀌거나 2분이 지나면 다시 검토해야 합니다.

기존 운송장은 덮어쓰지 않고, 새 항목만 `~/.config/streamdock-ai/parcels.json`에 추가합니다. 새 파일은 권한 0600으로 기록합니다. 이 작업은 운송장을 Cainiao에 보내지 않습니다. 배송 조회는 Mac 앱의 별도 검토와 기기 확인을 거칩니다.

파일 내용은 적용 직전에 재확인하고 원자적으로 교체합니다. 다른 프로그램이 **동시에** 같은 파일을 수정하면 검토와 교체 사이의 매우 짧은 경합을 완전히 막을 수 없으므로, 가져오기 중에는 파일을 직접 편집하지 마세요. 기존 파일 형식이 잘못됐거나 심볼릭 링크이면 적용하지 않습니다.

AliExpress 화면 구조는 바뀔 수 있습니다. 현재 구현은 열린 배송 탭에서 명시된 번호만 찾는 제한적 미리보기이며, 사용자 계정의 실제 페이지에서 검증하기 전에는 자동 가져오기를 보장하지 않습니다. 번호와 웹 주소는 일반 상태 API나 로그에 넣지 않습니다. 미리보기 번호는 사용자가 요청한 전용 검토 화면에만 표시합니다.
