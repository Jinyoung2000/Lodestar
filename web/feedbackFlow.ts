// 피드백 입력 창과 요소 고르기의 상태 전이. 둘은 배타적이지 않아서 열리면 입력 창(compose)과 고르기(picking)가 함께 켜진다.
// 화면 상태(web/store.ts 의 feedbackMode, feedbackPicking, feedbackTarget)와 1:1 이라 순수 함수로 두고 test/feedbackflow.test.ts 가 확인한다.

export type FeedbackFlow = {
  mode: "off" | "compose";
  picking: boolean;
  // 입력 창에 요소 칩이 붙어 있는지
  attached: boolean;
};

export const FLOW_OFF: FeedbackFlow = { mode: "off", picking: false, attached: false };

// 열기: 입력 창이 뜨고 요소 고르기도 켜진 채로 시작한다.
export function openFlow(): FeedbackFlow {
  return { mode: "compose", picking: true, attached: false };
}

// 화면 요소를 클릭해 칩으로 붙인다. 고르기는 꺼지고 입력 창은 그대로다. 그 사이 닫혔거나 고르기를 껐으면 무시한다.
export function attachElement(flow: FeedbackFlow): FeedbackFlow {
  if (flow.mode !== "compose" || !flow.picking) return flow;
  return { mode: "compose", picking: false, attached: true };
}

// Attach Element 단추. 켜고 끄기만 하고 붙은 칩은 건드리지 않는다.
export function togglePicking(flow: FeedbackFlow): FeedbackFlow {
  if (flow.mode !== "compose") return flow;
  return { ...flow, picking: !flow.picking };
}

// 칩의 X. 고르기는 다시 켜지 않는다(원하면 단추로).
export function removeElement(flow: FeedbackFlow): FeedbackFlow {
  return { ...flow, attached: false };
}

// Esc: 고르기가 켜져 있으면 고르기만 끄고, 꺼져 있으면 피드백을 닫는다.
export function pressEscape(flow: FeedbackFlow): FeedbackFlow {
  if (flow.mode === "off") return flow;
  if (flow.picking) return { ...flow, picking: false };
  return FLOW_OFF;
}

export type Box = { x: number; y: number; width: number; height: number };

// 요소 이름표를 놓을 자리. 기본은 윤곽 위(top 이 이름표의 아래 끝), 위 공간이 모자라면 윤곽 아래(top 이 이름표의 위 끝).
// 입력 창(avoid)과 가로 세로로 겹치면 반대쪽을 시도하고, 양쪽 다 겹치면 입력 창 바로 아래에 둔다. 이름표는 윤곽의 왼쪽 가장자리에서 labelWidth 만큼 뻗는다.
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
