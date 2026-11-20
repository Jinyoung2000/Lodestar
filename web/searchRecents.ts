import { noteStamp } from "./searchModel";
import { getCenterRef, subscribePr } from "./prStore";
import { getState, subscribe } from "./store";

// 통합 검색의 Recent 가 쓰는 "마지막으로 연 시각". 세션, 파일, PR, 보드 카드, 멘션을 어느 길로 열었든(사이드바, 검색창, 단축키) 상태가 바뀌는 순간을 듣고 적는다.
// store 에는 세션과 파일의 최근 목록만 있고 시각이 없어서, 종류가 다른 항목을 최근순으로 섞으려면 이 기록이 필요하다.

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
    // 저장이 막힌 환경에서는 이번 실행 동안만 유지
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
    // 세션과 파일은 열 때마다 최근 목록이 새 배열로 바뀌고 맨 앞이 방금 연 것이다.
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
