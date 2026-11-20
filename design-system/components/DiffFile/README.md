# DiffFile

변경 패널의 파일 하나. 헤더 줄과 unified diff 본문.

- 헤더: 높이 `size-pane-header` 35px, 바탕 `surface-base`, 아래 `border-subtle`. 접힘 화살표, 파일 이름 `ui-strong`, 경로 `code-sm` `fg-subtle`, `+36` `success` / `−4` `danger`, 상태 글자 A/M/D 는 `caption`, 오른쪽 "Viewed" 체크박스
- 본문: `code` 12.5px/20px, 줄 번호 열 48px `fg-subtle`, 추가 줄 `diff-add-bg`, 삭제 줄 `diff-del-bg`(줄 번호 열도 같은 색), 줄 안에서 바뀐 글자는 `diff-*-gutter`
- 바뀌지 않은 구간은 한 줄 "129 hidden lines" 로 접고(`caption` `fg-muted`, 가운데), 펼치기 아이콘
- 덩어리 오른쪽 위에 hover 때만 "유지", "되돌리기" 작은 고스트 버튼
