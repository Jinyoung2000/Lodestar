// SESSIONORDER: 사이드바에서 세션 행을 끌 때 포인터가 가리키는 "놓을 자리"를 고르는 순수 함수. DOM 을 몰라서 test/sessionorder.test.ts 가 그대로 부른다.
// 단위 블록 하나는 형제 세션 한 개와 그 아래 들여쓴 자손 행들이 차지하는 세로 구간이다(부모를 옮기면 자손도 같이 간다).

export type SlotBlock = { id: string; top: number; bottom: number };
export type Slot = { id: string; edge: "before" | "after" };

// blocks 는 위에서 아래 순서. bounds 밖(다른 묶음, 목록 밖)이면 null. 블록 사이 틈이나 첫 블록 위(묶음 머리)는 아래쪽 블록의 앞,
// 마지막 블록 아래(Show more 단추)는 마지막 블록의 뒤로 읽고, 블록 안에서는 가운데 선보다 위면 앞, 아니면 뒤다.
export function pickSlot(blocks: readonly SlotBlock[], y: number, bounds: { top: number; bottom: number }): Slot | null {
  if (blocks.length === 0 || y < bounds.top || y > bounds.bottom) return null;
  for (const block of blocks) {
    if (y > block.bottom) continue;
    if (y < block.top) return { id: block.id, edge: "before" };
    return { id: block.id, edge: y < (block.top + block.bottom) / 2 ? "before" : "after" };
  }
  return { id: blocks[blocks.length - 1].id, edge: "after" };
}
