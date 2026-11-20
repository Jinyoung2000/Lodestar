// 사이드바 Chat 뷰의 순수 로직. vscode 모듈을 쓰지 않는다. 루트의 test/vsext.test.ts 가 그대로 불러 시험한다.

// 세션을 어디에 여는지(설정 lodestar.openSessionIn). package.json 의 enum 과 같아야 하고 scripts/check-manifest.ts 가 대조한다.
export const OPEN_IN_VALUES = ["sidebar", "editor"] as const;
export type OpenIn = (typeof OPEN_IN_VALUES)[number];
export const DEFAULT_OPEN_IN: OpenIn = "sidebar";

export function normalizeOpenIn(value: unknown): OpenIn {
  return OPEN_IN_VALUES.find((v) => v === value) ?? DEFAULT_OPEN_IN;
}

// 사이드바 webview 가 살려 두는 세션 화면(iframe)의 수. 숨긴 iframe 은 입력창 초안과 스크롤을 그대로 들고 있다. 넘치면 가장 오래 안 본 것부터 버리고, 다시 열면 새로 불러온다.
export const MAX_FRAMES = 6;

// 화면 하나. 열린 세션은 agentId, 새 세션 입력창은 workspaceId 를 가진다. 배열 맨 뒤가 지금 보이는 화면이다.
// key 는 iframe 의 이름표라서 화면이 살아 있는 동안 바뀌지 않는다(입력창이 세션이 돼도 같은 key 라야 iframe 이 다시 불리지 않는다).
export type Frame = { key: string; agentId: string | null; workspaceId: string | null; src: string };

export function activeFrame(frames: Frame[]): Frame | null {
  return frames.at(-1) ?? null;
}

// 같은 곳을 보여 주는 화면인가. 세션은 agentId 로, 새 세션 입력창은 같은 폴더끼리 같다.
const sameTarget = (a: Frame, b: Frame) => (a.agentId ? a.agentId === b.agentId : !b.agentId && a.workspaceId === b.workspaceId);

// next 가 가리키는 화면을 맨 뒤(보이는 자리)로 올린다. 이미 있던 화면이면 그 화면(key, src 그대로)을 올려 iframe 이 다시 불리지 않는다.
export function showFrame(frames: Frame[], next: Frame, max = MAX_FRAMES): { frames: Frame[]; dropped: Frame[] } {
  const existing = frames.find((f) => sameTarget(f, next));
  const kept = [...frames.filter((f) => f !== existing), existing ?? next];
  const dropped = kept.slice(0, Math.max(0, kept.length - max));
  return { frames: kept.slice(dropped.length), dropped };
}

// 새 세션 입력창(draft)에서 첫 메시지를 보내 세션이 생겼다. 그 화면이 세션 화면이 된다(자리와 key 는 그대로).
// 같은 세션을 이미 보여 주는 다른 화면이 있으면 그쪽을 버린다. src 는 다시 불러올 때 쓸 세션 주소다(지금 iframe 은 다시 불리지 않는다).
export function bindFrame(frames: Frame[], key: string, agentId: string, src: string): { frames: Frame[]; dropped: Frame[] } {
  const target = frames.find((f) => f.key === key);
  if (!target || target.agentId === agentId) return { frames, dropped: [] };
  const dropped = frames.filter((f) => f !== target && f.agentId === agentId);
  const bound: Frame = { key, agentId, workspaceId: null, src };
  const next = frames.filter((f) => !dropped.includes(f)).map((f) => (f === target ? bound : f));
  // 버려진 화면이 보이던 자리였으면 새로 묶인 화면이 그 자리를 잇는다.
  if (dropped.includes(frames.at(-1) as Frame)) next.push(...next.splice(next.indexOf(bound), 1));
  return { frames: next, dropped };
}

export function dropFrame(frames: Frame[], key: string): Frame[] {
  return frames.filter((f) => f.key !== key);
}

// 데몬에서 사라진 세션의 화면을 뺀다. 새 세션 입력창은 세션이 아니라서 남긴다.
export function dropMissing(frames: Frame[], exists: (agentId: string) => boolean): { frames: Frame[]; dropped: Frame[] } {
  const dropped = frames.filter((f) => f.agentId !== null && !exists(f.agentId));
  return { frames: frames.filter((f) => !dropped.includes(f)), dropped };
}

export function frameTitle(frame: Frame | null, titleOf: (agentId: string) => string | undefined): string | undefined {
  if (!frame) return undefined;
  return frame.agentId ? titleOf(frame.agentId) ?? "Lodestar" : "New Session";
}

export type AttachSurface = "panel" | "sidebar";

// 에디터 선택을 어디에 첨부할지. 에디터 탭 패널에 포커스가 있으면 그 패널, 아니면 설정이 정한 쪽을 먼저 보고 없으면 다른 쪽을 쓴다.
export function pickAttachTarget(input: { openIn: OpenIn; panelFocused: boolean; panelsOpen: boolean; sidebarHasSession: boolean }): AttachSurface | null {
  if (input.panelFocused) return "panel";
  const order: AttachSurface[] = input.openIn === "editor" ? ["panel", "sidebar"] : ["sidebar", "panel"];
  return order.find((s) => (s === "panel" ? input.panelsOpen : input.sidebarHasSession)) ?? null;
}
