# Button

버튼은 세 종류, 크기 둘.

- 주요(primary): `accent` 바탕, `accent-fg` 글자. 한 화면에 하나(보내기, 허용, Sync)
- 보조(secondary): `surface-overlay` 바탕, `border` 테두리, `fg` 글자
- 고스트(ghost): 바탕 없음, `fg-muted` 글자, hover `surface-hover`
- 크기: 기본 `size-control` 28px(좌우 `space-3`), 작은 것 `size-control-sm` 24px(좌우 `space-2`). 글자 `ui-sm` 12px, 굵기 600 은 주요만
- 반경 `radius-md`, 아이콘만 있는 버튼은 정사각 + `radius-sm`
- 포커스: 2px `accent` 링, 1px 띄움. 비활성: 글자 `fg-subtle`, 바탕 없음
