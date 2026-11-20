# SessionList

사이드바의 세션 목록. 프로젝트 폴더 행 아래에 세션 행이 들여쓰기로 달린다.

- 폴더 행과 세션 행 모두 `size-row-lg` 28px, 좌우 `space-2`, 글자 `ui-sm`
- 세션 행은 폴더보다 `space-4` 들여쓴다. 갈래(Forked)와 worktree 세션은 한 단계(`space-4`) 더
- 선택은 `surface-selected` + `fg-strong`, hover 는 `surface-hover`, 반경 `radius-sm`
- 실행 중은 제목 앞 6px 점 `running`, 권한 대기는 같은 자리 점 `warning`. 글자로 상태를 쓰지 않는다
- 제목은 한 줄 말줄임. 오른쪽 메타(시간, 개수)는 `caption` `fg-subtle`, hover 때만 더보기 아이콘
