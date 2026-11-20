# StepGroup

에이전트 한 턴의 도구 호출 묶음. 접힌 상태가 기본이고 한 줄 요약만 보인다: "Completed 4 steps in 26s". 펼치면 단계마다 아이콘 + 한 줄.

- 요약 줄: `ui` 13px `fg-muted`, 왼쪽 접힘 화살표 16px, 높이 `size-row-lg`
- 단계 줄: `ui` 13px, 아이콘 16px `fg-subtle`, 동사(Ran, Read, Edited, Searched)는 `fg`, 대상은 `code-sm` 칩(`surface-inset`, `radius-sm`, 좌우 `space-1_5`, 최대 폭에서 말줄임)
- 단계 사이 간격 `space-1`, 묶음 위아래 `space-3`
- 실행 중인 마지막 단계만 `running` 색 점으로 표시. 실패한 단계는 아이콘을 `danger` 로
- 파일 대상은 칩이 아니라 `accent-text` 링크(누르면 에디터 그 줄)
