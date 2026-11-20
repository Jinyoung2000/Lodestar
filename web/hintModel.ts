// 사소한 결과 안내(말풍선)의 순수 로직: 얼마나 오래 보이는지, 어디에 붙는지, 어느 쪽에 놓이는지. 화면은 web/hint.ts 와 web/HintLayer.tsx.

export type HintRect = { left: number; top: number; right: number; bottom: number };
export type HintSize = { width: number; height: number };
export type HintSide = "above" | "below";
export type Placement = { left: number; top: number; side: HintSide };

// 짧은 문구는 2.5초, 긴 문구(다음에 할 일을 알려 주는 안내)는 읽을 시간을 더해 6초까지.
export const HINT_MIN_MS = 2_500;
export const HINT_MAX_MS = 6_000;
const SHORT_TEXT = 40;
const READ_MS_PER_CHAR = 60;

export function hintDuration(text: string) {
  const extra = Math.max(0, text.length - SHORT_TEXT) * READ_MS_PER_CHAR;
  return Math.min(HINT_MAX_MS, HINT_MIN_MS + extra);
}

// 방금 누른 곳으로 볼 수 있는 시간. 이보다 오래되면 키보드로 한 동작이라 보고 포커스가 있는 곳을 쓴다.
export const POINTER_FRESH_MS = 1_500;

export type AnchorInput = {
  // 호출한 쪽이 위치를 정한 경우(에디터, 단추, 직접 잰 영역)
  explicit: { kind: "editor" } | { kind: "rect"; rect: HintRect } | null;
  // 포커스가 CodeMirror 에디터 안에 있는지
  focusInEditor: boolean;
  // 마지막으로 누른 곳. 누른 요소가 이미 사라졌어도(메뉴 항목) 누를 때의 영역이 남는다.
  pointer: { rect: HintRect; at: number } | null;
  now: number;
  // 포커스를 가진 요소의 영역. 보이지 않거나 없으면 null
  focused: HintRect | null;
};

export type ChosenAnchor = { kind: "explicit-editor" } | { kind: "focused-editor" } | { kind: "rect"; rect: HintRect; from: "explicit" | "pointer" | "focus" } | { kind: "window" };

// 안내를 붙일 곳을 고른다: 호출한 쪽이 정한 곳, 에디터에 포커스가 있으면 커서 위, 방금 누른 곳, 포커스가 있는 요소, 그것도 없으면 창 아래쪽 가운데.
export function chooseAnchor(input: AnchorInput): ChosenAnchor {
  if (input.explicit?.kind === "editor") return { kind: "explicit-editor" };
  if (input.explicit?.kind === "rect") return { kind: "rect", rect: input.explicit.rect, from: "explicit" };
  if (input.focusInEditor) return { kind: "focused-editor" };
  if (input.pointer && input.now - input.pointer.at <= POINTER_FRESH_MS && hasArea(input.pointer.rect)) return { kind: "rect", rect: input.pointer.rect, from: "pointer" };
  if (input.focused && hasArea(input.focused)) return { kind: "rect", rect: input.focused, from: "focus" };
  return { kind: "window" };
}

export function hasArea(rect: HintRect) {
  return rect.right - rect.left > 0 && rect.bottom - rect.top > 0;
}

// 요소를 못 찾았을 때 쓰는 자리: 창 아래쪽 가운데의 한 점. 말풍선은 이 점 위에 놓인다.
export function windowPoint(viewport: HintSize, lift: number): HintRect {
  const x = viewport.width / 2;
  const y = viewport.height - lift;
  return { left: x, right: x, top: y, bottom: y };
}

// 영역 위에 가운데 맞춰 놓고, 위가 모자라면 아래로 뒤집는다. 가로는 창 안으로 밀어 넣는다.
export function placeBubble(anchor: HintRect, size: HintSize, viewport: HintSize, gap: number, margin: number): Placement {
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(margin, Math.min(center - size.width / 2, viewport.width - margin - size.width));
  const aboveTop = anchor.top - gap - size.height;
  if (aboveTop >= margin) return { left, top: aboveTop, side: "above" };
  const belowTop = anchor.bottom + gap;
  const fitsBelow = belowTop + size.height <= viewport.height - margin;
  return { left, top: fitsBelow ? belowTop : Math.max(margin, aboveTop), side: fitsBelow ? "below" : "above" };
}

// 눌러도 안내를 닫지 않는 키: 단축키를 이루는 보조키 자체
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Fn"]);

export function dismissesOnKey(key: string) {
  return !MODIFIER_KEYS.has(key);
}
