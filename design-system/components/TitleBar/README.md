# TitleBar

창 맨 위 35px 줄. 신호등 버튼 자리 78px 를 비우고, 왼쪽에 사이드바 토글과 뒤로/앞로, 가운데에 프로젝트 검색창(누르면 파일, 세션 팔레트), 오른쪽에 git 동기화 버튼과 패널 토글을 둔다.

- 높이 `size-titlebar`, 바탕 `surface-raised`, 아래 `border-subtle`
- 아이콘 버튼은 `size-control-sm` 24px, `radius-sm`, hover `surface-hover`
- 검색창은 폭 360px 안팎, 높이 24px, `surface-overlay` + `border`, 글자 `ui-sm` `fg-muted`, 가운데 정렬
- 동기화 버튼은 작은 주요 버튼(`accent`)으로, 보낼 커밋이 있을 때만 채운다. 없으면 고스트
- 빈 곳은 창 끌기 영역, 버튼과 검색창은 끌기 제외
