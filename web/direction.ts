import "./directions/rounded.css";
import "./directions/rounded-shapes.css";
import { dismissNotice, notify } from "./notices";
import { openChoice } from "./QuickChoice";
import { S } from "./strings";

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
  }
  applyDirection(picked as DirectionId);
  announceDirection(picked as DirectionId);
}

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

function applyDirection(id: DirectionId) {
  if (id === "default") delete document.documentElement.dataset.direction;
  else document.documentElement.dataset.direction = id;
}
