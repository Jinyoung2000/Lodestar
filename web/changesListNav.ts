// depth 는 트리 보기의 들여쓰기 단계(목록 보기는 모두 0), folder 는 폴더 행인지, expanded 는 그 폴더가 펴져 있는지.
export type NavRow = { depth: number; folder: boolean; expanded: boolean };

// focus 는 index 번 행으로 포커스를 옮기고, toggle 은 지금 행(폴더)을 펴거나 접는다. null 이면 이 키를 다루지 않는다.
export type NavAction = { type: "focus"; index: number } | { type: "toggle" } | null;

// 한 화면에 들어오는 행 수를 모를 때 PageUp, PageDown 이 건너뛰는 행 수
export const PAGE_ROWS = 10;

// key 는 KeyboardEvent.key, at 은 포커스가 있는 행의 자리(-1 이면 행 밖). 수정키가 눌린 키는 부르는 쪽이 걸러 보낸다.
export function listNav(key: string, rows: readonly NavRow[], at: number, page = PAGE_ROWS): NavAction {
  if (rows.length === 0) return null;
  const last = rows.length - 1;
  const go = (index: number): NavAction => ({ type: "focus", index: Math.min(Math.max(index, 0), last) });
  switch (key) {
    case "ArrowDown":
      return go(at === -1 ? 0 : at + 1);
    case "ArrowUp":
      return go(at === -1 ? last : at - 1);
    case "Home":
      return go(0);
    case "End":
      return go(last);
    case "PageDown":
      return go(at === -1 ? 0 : at + page);
    case "PageUp":
      return go(at === -1 ? last : at - page);
  }
  const row = rows[at];
  if (!row) return null;
  if (key === "ArrowRight") {
    if (!row.folder) return null;
    if (!row.expanded) return { type: "toggle" };
    // 펴진 폴더에서 오른쪽은 첫 자식으로. 비어 있으면(자식이 없는 폴더) 가만히 둔다.
    return rows[at + 1] && rows[at + 1].depth > row.depth ? go(at + 1) : null;
  }
  if (key === "ArrowLeft") {
    if (row.folder && row.expanded) return { type: "toggle" };
    const parent = parentOf(rows, at);
    return parent === -1 ? null : go(parent);
  }
  return null;
}

// at 행의 부모 폴더 자리: 위로 올라가며 처음 만나는 더 얕은 행. 없으면 -1.
export function parentOf(rows: readonly NavRow[], at: number): number {
  for (let i = at - 1; i >= 0; i--) if (rows[i].depth < rows[at].depth) return i;
  return -1;
}
