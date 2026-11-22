
export type FeedbackFlow = {
  mode: "off" | "compose";
  picking: boolean;
  attached: boolean;
};

export const FLOW_OFF: FeedbackFlow = { mode: "off", picking: false, attached: false };

export function openFlow(): FeedbackFlow {
  return { mode: "compose", picking: true, attached: false };
}

export function attachElement(flow: FeedbackFlow): FeedbackFlow {
  if (flow.mode !== "compose" || !flow.picking) return flow;
  return { mode: "compose", picking: false, attached: true };
}

export function togglePicking(flow: FeedbackFlow): FeedbackFlow {
  if (flow.mode !== "compose") return flow;
  return { ...flow, picking: !flow.picking };
}

export function removeElement(flow: FeedbackFlow): FeedbackFlow {
  return { ...flow, attached: false };
}

export function pressEscape(flow: FeedbackFlow): FeedbackFlow {
  if (flow.mode === "off") return flow;
  if (flow.picking) return { ...flow, picking: false };
  return FLOW_OFF;
}

export type Box = { x: number; y: number; width: number; height: number };

export function labelPlacement(rect: Box, avoid: Box | null, labelHeight: number, labelWidth: number): { top: number; below: boolean } {
  const above = { top: rect.y, below: false };
  const below = { top: rect.y + rect.height, below: true };
  const band = (p: { top: number; below: boolean }) => (p.below ? [p.top, p.top + labelHeight] : [p.top - labelHeight, p.top]);
  const hits = (p: { top: number; below: boolean }) => {
    if (!avoid) return false;
    const [from, to] = band(p);
    const overlapsX = rect.x < avoid.x + avoid.width && rect.x + labelWidth > avoid.x;
    return overlapsX && from < avoid.y + avoid.height && to > avoid.y;
  };
  const order = rect.y < labelHeight ? [below, above] : [above, below];
  const first = order.find((p) => !hits(p) && (p.below || p.top - labelHeight >= 0));
  if (first) return first;
  return { top: avoid ? avoid.y + avoid.height : below.top, below: true };
}
