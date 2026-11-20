# Composer

대화 입력창. 위에 세션 변경 요약 칩 줄, 안에 입력과 컨트롤 줄, 아래에 권한 모드 표시.

- 상자: `surface-overlay`, `border`, `radius-lg`, 안쪽 패딩 `space-3`, 포커스 시 테두리 `accent`
- 입력 글자 `ui` 13px, placeholder "Chat with Claude" 는 `fg-muted`
- 컨트롤 줄 높이 `size-control-sm`, 항목 사이 `space-1`: 첨부(+), 모드, 모델, effort 는 고스트 칩(`ui-sm`, hover `surface-hover`), 오른쪽 끝 보내기는 24px 정사각 주요 버튼(입력이 비면 비활성)
- 위 요약 칩: "318 Files +15274 −3232" 에서 +는 `success`, −는 `danger`, 나머지 `fg-muted`. 칩 사이 `space-2`
- 아래 권한 표시: `caption`, Bypass 는 `warning`, 그 외 `fg-subtle`
- 첨부한 파일과 선택 영역은 입력 위에 `code-sm` 칩(`path:10-14`)으로, 칩마다 닫기 아이콘
