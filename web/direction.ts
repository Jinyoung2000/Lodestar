import "./directions/rounded.css";
import "./directions/rounded-shapes.css";
import { dismissNotice, notify } from "./notices";
import { openChoice } from "./QuickChoice";
import { S } from "./strings";

// 디자인 시안 미리보기. <html data-direction> 이 있을 때만 web/directions/*.css 가 적용되고, 선택은 이 브라우저의 localStorage 에만 남는다(서버 설정은 건드리지 않는다).
const KEY = "agent-nav.design-direction";

export const DIRECTIONS = [
  { id: "default", label: "Default", detail: "Current design" },
  { id: "rounded", label: "Rounded", detail: "Larger corner radii, pill selections and chips" },
] as const;
export type DirectionId = (typeof DIRECTIONS)[number]["id"];

export function initDirection() {
  const id = storedDirection();
  applyDirection(id);
  announceDirection(id);
}

export async function previewDesignDirection() {
  const current = storedDirection();
  const items = DIRECTIONS.map((d) => ({ id: d.id, label: d.id === current ? `${d.label} (current)` : d.label, detail: d.detail }));
  const picked = await openChoice({ title: S.previewDirectionTitle, placeholder: S.previewDirectionPlaceholder, items });
  if (!picked) return;
  try {
    localStorage.setItem(KEY, picked);
  } catch {
    // 저장이 막혀도 이번 실행에서는 바뀐다
  }
  applyDirection(picked as DirectionId);
  announceDirection(picked as DirectionId);
}

// 미리보기 중이라는 것과 되돌리는 방법을 토스트로 알린다. 되돌리기 단추는 Default 를 고른 것과 같다.
function announceDirection(id: DirectionId) {
  if (id === "default") {
    if (previewNotice !== null) dismissNotice(previewNotice);
    previewNotice = null;
    return;
  }
  const label = DIRECTIONS.find((d) => d.id === id)?.label ?? id;
  previewNotice = notify({
    key: "design-preview",
    message: S.directionPreviewing(label),
    detail: S.directionPreviewHow,
    actions: [{ label: S.directionRevert, run: () => revertDirection() }],
    autoHideMs: PREVIEW_NOTICE_MS,
  });
}

function revertDirection() {
  try {
    localStorage.setItem(KEY, "default");
  } catch {
    // 저장이 막혀도 이번 실행에서는 바뀐다
  }
  applyDirection("default");
  previewNotice = null;
}

let previewNotice: number | null = null;
const PREVIEW_NOTICE_MS = 30_000;

function storedDirection(): DirectionId {
  try {
    const value = localStorage.getItem(KEY);
    return DIRECTIONS.some((d) => d.id === value) ? (value as DirectionId) : "default";
  } catch {
    return "default";
  }
}

// default 는 속성을 지운다. 속성이 없으면 시안 CSS 가 하나도 걸리지 않는다.
function applyDirection(id: DirectionId) {
  if (id === "default") delete document.documentElement.dataset.direction;
  else document.documentElement.dataset.direction = id;
}
