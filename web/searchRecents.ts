import { noteStamp } from "./searchModel";
import { getCenterRef, subscribePr } from "./prStore";
import { getState, subscribe } from "./store";

const KEY = "agent-nav:search-recents";

function load(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

let stamps = load();
let started = false;

export const getStamps = () => stamps;

function note(key: string) {
  stamps = noteStamp(stamps, key, Date.now());
  try {
    localStorage.setItem(KEY, JSON.stringify(stamps));
  } catch {
  }
}

export function startRecentTracking() {
  if (started) return;
  started = true;
  let s = getState();
  let pr = getCenterRef();
  subscribe(() => {
    const prev = s;
    s = getState();
    if (s.recentAgentIds !== prev.recentAgentIds && s.recentAgentIds[0]) note(`session:${s.recentAgentIds[0]}`);
    if (s.recentFiles !== prev.recentFiles && s.recentFiles[0]) note(`file:${s.recentFiles[0].workspaceId}:${s.recentFiles[0].path}`);
    if (s.selectedCardId !== prev.selectedCardId && s.selectedCardId) note(`card:${s.selectedCardId}`);
    if (s.boardCardId !== prev.boardCardId && s.boardCardId) note(`card:${s.boardCardId}`);
    if (s.selectedInboxId !== prev.selectedInboxId && s.selectedInboxId) note(`mention:${s.selectedInboxId}`);
  });
  subscribePr(() => {
    const open = getCenterRef();
    if (open !== pr && open) note(`pr:${open.repo}#${open.number}`);
    pr = open;
  });
}
