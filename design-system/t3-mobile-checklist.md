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
- [x] 모델 목록, 지원 effort와 제공자 전환 가능 여부는 연결된 Mac이 결정한다. 모바일에서 시작한 세션에는 Mac의 기본 권한을 적용한다.

[T3 ThreadSettingsSheet](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/features/threads/ThreadSettingsSheet.tsx) · [Lodestar ModelPicker](../mobile/src/ui/ModelPicker.tsx) · [Mac 모바일 RPC](../server/index.ts)

## 목록, 결과와 연결

- [x] 펼친 화면에서 세션 목록을 왼쪽에 둔다. 기존 대화, 새 대화, 모델 선택은 오른쪽에 표시한다. 좁은 창은 한 화면씩 이동한다.
- [x] 일반 대화가 세로 공간을 차지한다. 생성된 미리보기가 있으면 상단 아이콘으로 갤러리를 연다. HTML, SVG, 이미지, Markdown, CSV는 대화에서도 열 수 있다.
- [x] 승인을 기다릴 때 입력 위치에서 응답한다. 허용·거절 결과는 해당 도구 실행에 표시한다. 직접 답한 질문만 대화에 답변으로 남긴다.
- [x] Android 이미지 붙여넣기는 기존 썸네일과 전송 경로를 사용한다. 백그라운드 연결과 질문 알림은 페어링한 Mac을 따른다.
- [x] 오프라인 안내는 Fold 창에서 한 번만 표시한다. 캐시된 대화를 읽을 수 있고, 저장된 기록이 없으면 빈 상태에서 재연결할 수 있다.

[T3 Android 작업공간](https://github.com/pingdotgg/t3code/blob/c9e9e7d36a91044bdcd9c7e1163c97de297f5bde/apps/mobile/src/features/layout/workspace/WorkspaceRootScreen.android.tsx) · [Lodestar 화면 구성](../mobile/src/app/_layout.tsx) · [Android 배포와 연결](../README.md#android-companion)

## 기기에서 대조할 순서

1. Fold에 기존 클라이언트를 설치한 상태에서 Settings의 App updates로 업데이트한다. 업데이트 전후에 앱 패키지, 페어링과 현재 OTA 식별자를 확인한다.
2. 새 대화와 기존 대화에서 짧은 글과 두 줄 이상인 글을 입력한다. 모델 버튼을 누르고 돌아와 입력한 내용과 첨부가 유지되는지 본다.
3. 다른 모델을 선택하고 닫아서 기존 선택을 확인한다. 다시 열어 Save로 선택한 모델과 effort를 적용한다. 검색과 즐겨찾기로 같은 모델을 찾는다.
4. 390dp에서 키보드를 열고 입력창과 버튼이 키보드 위에 보이는지 확인한다. Fold에서 모델을 고를 때에도 왼쪽 목록은 사용할 수 있어야 한다.

T3 원본에는 음성 입력, 터미널, Runtime 편집도 있다. 이 표에서 Lodestar에 맞춘 차이는 이미지 첨부, 세션 미리보기, Mac 권한 상속이다. 음성과 터미널은 이 대조표의 구현 범위 밖이다.
