# T3 Android 대화 화면 대조표

기준은 2026년 11월 22일 공식 Android 빌드 2.3.0 (813)이다. 같은 에뮬레이터에서 격리된 Mac 서버에 연결하고 펼친 화면 750dp, 접은 화면 390dp에서 새 대화와 모델 목록을 열었다. 아래 항목은 세션 관리, 대화 작성, 모델과 effort 선택, 결과 확인을 다룬다. [공식 릴리스](https://github.com/pingdotgg/t3code/releases/tag/v0.1.12-nightly.20261122.5085)

## 대화 작성

- [x] 새 대화와 기존 대화 모두 하단 입력창으로 시작한다. 새 대화의 작업 위치는 상단에서 바꾸며, 워크트리 생성 바로가기는 해당 설정을 바로 연다.
- [x] 짧은 입력은 한 줄에 첨부, 입력칸, 제공자 아이콘과 펼침 표시, 전송 순서로 배치한다. 모델을 고르는 버튼은 전송 버튼 바로 왼쪽에 둔다.
- [x] 입력이 좁은 칸을 넘으면 편집 영역을 버튼 위로 펼친다. 모델 이름과 지원되는 effort를 드러내고, 긴 입력은 최대 네 줄 뒤부터 내부에서 스크롤한다. 접거나 펼칠 때 입력칸은 한 번만 마운트한다.
- [x] `/model`을 선택하면 같은 모델 화면을 열고 해당 명령만 지운다. 일반 대화 전송 요청은 발생하지 않는다.
- [x] 실행 중에는 정지 버튼을 표시한다. Lodestar에서 추가 입력을 작성하면 Queue와 Steer를 고를 수 있다.

[T3 ThreadComposer](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/features/threads/ThreadComposer.tsx) · [T3 ComposerSurface](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/components/ComposerSurface.tsx) · [Lodestar Composer](../mobile/src/ui/Composer.tsx)

## 모델과 effort

- [x] 모델 화면은 휴대폰에서는 창 전체에, Fold에서는 대화가 열려 있던 오른쪽 패널에 표시한다. 닫으면 작성 중인 대화로 돌아간다.
- [x] 상단에 닫기, `Find a model` 검색창, 필터, Done 또는 Save를 둔다. 제공자별 목록에서 현재 모델을 표시하고 별 버튼으로 즐겨찾기를 바꾼다.
- [x] 모델을 누르면 선택을 미리 표시한다. Save는 적용하고, 닫기와 뒤로 가기는 미적용 선택을 버린다.
- [x] Options의 Reasoning effort에는 해당 모델이 지원하는 수준만 표시한다. 현재 모델의 effort만 바꾸면 바로 적용한다. 새 모델을 함께 고르면 Save에서 둘을 같이 적용한다.
- [x] 이전에 받은 모델은 선택기를 열면 바로 표시한다. 처음 연결했을 때는 제공자별 목록이 도착하는 순서대로 표시한다. PC와 폰에서 누른 별표는 Mac 데몬에 저장한다.
- [x] 모델 목록, 지원 effort와 제공자 전환 가능 여부는 연결된 Mac이 결정한다. 모바일에서 시작한 세션에는 Mac의 기본 권한을 적용한다.

[T3 ThreadSettingsSheet](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/features/threads/ThreadSettingsSheet.tsx) · [Lodestar ModelPicker](../mobile/src/ui/ModelPicker.tsx) · [Mac 모바일 RPC](../server/index.ts)

## 목록, 결과와 연결

- [x] 목록을 좌우로 밀어 Sessions, Waiting, Workspaces를 오간다. Fold에서는 왼쪽 목록에서 탭을 바꿔도 오른쪽 대화가 그대로 있다.

- [x] 펼친 화면에서 세션 목록을 왼쪽에 둔다. 기존 대화, 새 대화, 모델 선택은 오른쪽에 표시한다. 좁은 창은 한 화면씩 이동한다.
- [x] 일반 대화가 세로 공간을 차지한다. 생성된 미리보기가 있으면 상단 아이콘으로 갤러리를 연다. HTML, SVG, 이미지, Markdown, CSV는 대화에서도 열 수 있다.
- [x] 승인을 기다릴 때 입력 위치에서 응답한다. 허용·거절 결과는 해당 도구 실행에 표시한다. 직접 답한 질문만 대화에 답변으로 남긴다.
- [x] Android 이미지 붙여넣기는 기존 썸네일과 전송 경로를 사용한다. 백그라운드 연결과 질문 알림은 페어링한 Mac을 따른다.
- [x] 재연결이 길어지면 기존 앱 제목 아래에 상태를 표시한다. Fold에서는 한 곳에만 표시하며, 대화와 초안이 있는 자리는 그대로 둔다.
- [x] 임시 통신 오류가 발생하면 열려 있는 대화의 기록을 자동으로 다시 요청한다. 서버가 특정 대화에 반환한 오류는 해당 대화에서 확인한다.
- [x] 워크스페이스 정렬 아이콘을 누르면 Recent, Name, Manual 메뉴가 열린다. 현재 기준에 체크를 표시한다.

[T3 Android 작업공간](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.android.tsx) · [Lodestar 화면 구성](../mobile/src/app/_layout.tsx) · [Android 배포와 연결](../README.md#android-companion)

## 기기에서 대조할 순서

1. Fold에 기존 클라이언트를 설치한 상태에서 Settings의 App updates로 업데이트한다. 업데이트 전후에 앱 패키지, 페어링과 현재 OTA 식별자를 확인한다.
2. 새 대화와 기존 대화에서 짧은 글과 두 줄 이상인 글을 입력한다. 모델 버튼을 누르고 돌아와 입력한 내용과 첨부가 유지되는지 본다.
3. 다른 모델을 선택하고 닫아서 기존 선택을 확인한다. 다시 열어 Save로 선택한 모델과 effort를 적용한다. 검색과 즐겨찾기로 같은 모델을 찾는다.
4. 390dp에서 키보드를 열고 입력창과 버튼이 키보드 위에 보이는지 확인한다. Fold에서 모델을 고를 때에도 왼쪽 목록은 사용할 수 있어야 한다.

T3 원본에는 음성 입력, 터미널, Runtime 편집도 있다. 이 표에서 Lodestar에 맞춘 차이는 이미지 첨부, 세션 미리보기, Mac 권한 상속이다. 음성과 터미널은 이 대조표의 구현 범위 밖이다.

## 2026-11-22 Android 검증 기록

| 조건 | 확인한 결과 |
| --- | --- |
| 공식 T3 813, 750dp와 390dp | 같은 초안에서 Fold의 왼쪽 목록, 접은 화면의 뒤로가기, 두 줄 입력과 키보드 위의 모델 버튼을 확인했다. |
| Lodestar Fold 750dp | 기존 대화에서 모델 검색과 필터를 열었다. 다른 모델을 고르고 닫았을 때 원래 모델과 두 줄 초안이 남았다. 새 대화에서는 제목과 작업 위치가 같은 바에 표시됐다. |
| 격리한 Mac 데몬 | 모델과 effort를 저장한 뒤 데몬에서 같은 세션을 다시 조회했다. 저장값은 `gpt-fixture-mini`와 `medium`이었다. 입력창에서 `/model` 제안을 눌러 모델 화면을 열고 닫았을 때 앞에 입력한 글이 남았다. 대화 기록에 명령 전송 내역은 없었다. |
| Lodestar 390dp와 320dp | 390dp에서 키보드 위에 입력창이 표시됐다. 320dp, 글꼴 160%에서는 검색 안내 `Search` 전체와 필터, 확인 버튼이 한 줄에 들어갔다. |
| 기존 Android 0.2.1 설치 | APK를 재설치하지 않고 업데이트했다. Settings에서 `0.2.1 · OTA eb8acc4b`과 이전 Mac 연결을 확인했다. |
| 개인 S3 설치 파일 | 고정 경로 `android/latest/lodestar.apk`에서 최신 빌드 `897eb090`을 다시 내려받아 35,966,521바이트 전체의 SHA-256이 서명한 로컬 APK와 같은지 확인했다. |

[배포한 Android OTA](https://expo.dev/accounts/jinzero/projects/lodestar-mobile/updates/3d448a67-3f6e-41f6-9db7-73d8cd300ab3)

## 모델 즐겨찾기와 탭 전환 검증

| 조건 | 확인한 결과 |
| --- | --- |
| 모델 목록 캐시 | 한 제공자의 응답을 보류해도 다른 제공자의 목록이 먼저 표시됐다. 5회 다시 열었을 때 목록 요청은 0건이었다. 앱을 새로 시작해도 네트워크 응답 전에 저장된 모델을 읽었다. |
| 기존 PC의 별표 | PC에 저장된 별표를 처음 읽을 때 원래 순서를 유지했다. 이관 전에 폰에서 별을 추가하거나 해제한 경우와 빈 목록을 저장하고 다시 시작한 경우를 검증했다. |
| Android와 격리 데몬 | PC가 지정한 GPT Fixture Mini가 폰의 즐겨찾기에 표시됐다. 폰에서 GPT Fixture에 별표를 추가한 뒤 PC에서 두 모델을 확인했다. |
| Fold 목록 | 세션 행 위와 비어 있는 Waiting 화면에서 좌우로 밀어 세 탭을 왕복했다. 오른쪽 대화의 초안이 유지됐다. 390dp에서도 세 탭을 왕복했다. |
| Android 배포 | 0.2.1 설치에서 OTA `4fdb26db`를 적용했다. 개인 S3의 APK 전체를 다시 받아 서명한 빌드와 SHA-256이 같은지 확인했다. |

[모델 캐시·즐겨찾기·스와이프 Android 업데이트](https://expo.dev/accounts/jinzero/projects/lodestar-mobile/updates/a5bbf3fc-742d-419e-a670-76f208910669)

## 연결 복구와 정렬 검증

- Android 0.2.1에서 Settings로 OTA `6e6e942f`를 적용했다. Fold 에뮬레이터에서 테스트 데몬을 25초 동안 중지했다. 제목 아래의 연결 상태만 바뀌었고, 선택한 세션의 대화, 미리보기 목록과 입력하던 두 줄이 유지됐다. 서버가 돌아온 뒤 별도 조작 없이 연결됐다.
- 첫 대화 기록 요청이 시간 초과되는 경우도 따로 재현했다. 폰은 최근 16개 항목부터 다시 요청했고, 세션을 닫으면 재시도를 중단했다.
- Workspaces에서 정렬 아이콘으로 Name을 선택하면 Aster가 첫 행이었고, Recent로 돌아가면 최근 대화가 있는 Lodestar UX Lab이 첫 행이었다. 메뉴를 다시 열었을 때 선택한 항목의 체크와 Manual 선택도 확인했다.

[T3 대화 열기와 연결 복구](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/features/threads/ThreadRouteScreen.tsx) · [배포한 Android 업데이트](https://expo.dev/accounts/jinzero/projects/lodestar-mobile/updates/d765d1d8-9f3c-4d40-a283-889e7c6a6420)
