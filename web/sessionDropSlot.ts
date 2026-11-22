
export type SlotBlock = { id: string; top: number; bottom: number };
export type Slot = { id: string; edge: "before" | "after" };

export function pickSlot(blocks: readonly SlotBlock[], y: number, bounds: { top: number; bottom: number }): Slot | null {
  if (blocks.length === 0 || y < bounds.top || y > bounds.bottom) return null;
  for (const block of blocks) {
    if (y > block.bottom) continue;
    if (y < block.top) return { id: block.id, edge: "before" };
    return { id: block.id, edge: y < (block.top + block.bottom) / 2 ? "before" : "after" };
  }
  return { id: blocks[blocks.length - 1].id, edge: "after" };
}
