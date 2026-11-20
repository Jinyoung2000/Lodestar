import type { TimelineItem } from "../shared/protocol";
import { windowStorage } from "./windowStorage";

// 입력창이 화면 밖에서도 들고 있어야 하는 상태. 세션을 바꿨다 돌아오거나 폴더를 바꿔 새 세션 화면이 다시 만들어져도 쓰던 글이 남는다.

// 초안은 메모리에 두고, 창 상태 저장본과 따로 localStorage 에 초안마다 키 하나로 바로 쓴다. 창을 다시 읽거나 앱을 껐다 켜도 돌아온다. 키는 세션 id, 새 세션 화면은 `new:<칸 id>`.
// 창 상태 저장본에 실으면 글자를 칠 때마다 칸과 탭 전체를 다시 직렬화하고(지연 400ms 동안 마지막 입력이 빠질 수 있었다), 큰 글이 매번 그 안에서 복사됐다. 따로 쓰면 바뀐 초안 하나만 쓴다(test/draftsave.test.ts).
const drafts = new Map<string, string>();
export const DRAFT_STORAGE_PREFIX = "agent-nav:draft:";
// 이보다 짧은 글은 입력과 같은 호출 안에서 바로 쓴다. 긴 글은 짧게 묶어서 쓰고, 창을 닫거나 다시 읽기 직전(flushDrafts)에 남은 것을 쓴다.
export const DRAFT_SYNC_LIMIT = 20_000;
export const DRAFT_DEBOUNCE_MS = 150;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
let draftStorage: DraftStorage | null | undefined;
const unsaved = new Set<string>();
let draftTimer: ReturnType<typeof setTimeout> | null = null;

function storage(): DraftStorage | null {
  if (draftStorage !== undefined) return draftStorage;
  return windowStorage();
}

// 쓸 저장소를 바꾼다. null 이면 저장하지 않고(확장 안 화면), undefined 이면 localStorage. 시험에서 가짜 저장소를 끼운다.
export function setDraftStorage(next: DraftStorage | null | undefined) {
  draftStorage = next;
}

function writeDraft(key: string) {
  unsaved.delete(key);
  try {
    const text = drafts.get(key);
    if (text) storage()?.setItem(DRAFT_STORAGE_PREFIX + key, text);
    else storage()?.removeItem(DRAFT_STORAGE_PREFIX + key);
  } catch {
    // 용량을 넘었거나 막힌 저장소여도 입력은 그대로 된다
  }
}

// 아직 못 쓴 긴 글을 지금 쓴다. 창을 닫거나 다시 읽기 직전, 데몬 재시작으로 창을 다시 읽기 직전에 부른다.
export function flushDrafts() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = null;
  for (const key of [...unsaved]) writeDraft(key);
}

function saveDraft(key: string) {
  if ((drafts.get(key)?.length ?? 0) <= DRAFT_SYNC_LIMIT) {
    writeDraft(key);
    return;
  }
  unsaved.add(key);
  draftTimer ??= setTimeout(flushDrafts, DRAFT_DEBOUNCE_MS);
}

// 저장소에 남은 초안 전부. 창 상태 저장본(extras.drafts)에 있던 옛 저장본은 restoreDrafts 로 먼저 넣고, 이것을 나중에 넣어 덮는다.
export function loadStoredDrafts(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const store = storage();
    for (let i = 0; store && i < store.length; i++) {
      const name = store.key(i);
      if (!name?.startsWith(DRAFT_STORAGE_PREFIX)) continue;
      const text = store.getItem(name);
      if (text) out[name.slice(DRAFT_STORAGE_PREFIX.length)] = text;
    }
  } catch {
    // 막힌 저장소
  }
  return out;
}

// 새 세션 칸(`new:<칸 id>`)의 초안 중 칸이 사라진 것을 저장소에서 지운다. 칸은 창 상태 저장본으로 되살아나므로, 되살린 칸 목록에 없으면 주인이 없는 초안이다.
export function dropStoredDraftsOfMissingPanes(paneIds: ReadonlySet<string>) {
  for (const key of Object.keys(loadStoredDrafts())) {
    if (!key.startsWith("new:") || paneIds.has(key.slice(4))) continue;
    drafts.delete(key);
    unsaved.delete(key);
    writeDraft(key);
  }
}

export const draftKey = (agentId: string | null, paneId: string) => (agentId ? agentId : `new:${paneId}`);

// FIX6C: 입력창 첨부(핸드오프 칩, 이미지, 파일 선택 영역)는 초안 글과 같은 키로 묶는다. 칸 id 로 묶으면 칸에 다른 세션이 들어올 때(⇧⌘T 로 닫은 칸 복원) 앞 칸의 첨부가 따라 붙는다.
// 세션이 열린 칸이면 세션 id, 새 세션 화면이면 `new:<칸 id>`.
export function attachmentKey(panes: ReadonlyArray<{ id: string; kind: string; agentId?: string }>, paneId: string) {
  const pane = panes.find((p) => p.id === paneId);
  return draftKey(pane?.kind === "agent" ? (pane.agentId ?? null) : (virtualPanes.get(paneId) ?? null), paneId);
}

// NOTION2: 칸 목록(panes)에 없는 곳에 놓인 세션 입력창(Notion 화면의 페이지 전용 대화)이 첨부를 자기 세션 키로 묶게, 칸 id 와 세션 id 를 짝지어 둔다.
const virtualPanes = new Map<string, string>();

export function bindVirtualPane(paneId: string, agentId: string) {
  virtualPanes.set(paneId, agentId);
  return () => {
    if (virtualPanes.get(paneId) === agentId) virtualPanes.delete(paneId);
  };
}

export function getDraft(key: string) {
  return drafts.get(key) ?? "";
}

export function setDraft(key: string, text: string) {
  if (text === (drafts.get(key) ?? "")) return;
  if (text) drafts.set(key, text);
  else drafts.delete(key);
  saveDraft(key);
}

export const snapshotDrafts = (): Record<string, string> => Object.fromEntries(drafts);

// 옛 창 상태 저장본(extras.drafts)에서 읽은 초안도 받는다. 저장소 쪽으로 옮겨 쓰므로 창 상태 저장본이 더는 초안을 싣지 않아도 사라지지 않는다.
export function restoreDrafts(saved: Record<string, string>) {
  for (const [key, text] of Object.entries(saved)) {
    if (!text) continue;
    drafts.set(key, text);
    writeDraft(key);
  }
}

// 지워진 세션의 초안을 버린다(새 세션 칸의 `new:` 초안은 칸이 정한다).
export function dropDraftsOfMissing(agentIds: ReadonlySet<string>) {
  for (const key of [...drafts.keys()]) {
    if (key.startsWith("new:") || agentIds.has(key)) continue;
    drafts.delete(key);
    unsaved.delete(key);
    writeDraft(key);
  }
}

export const HISTORY_LIMIT = 50;

// 이 세션에서 사용자가 보낸 글, 오래된 것부터 최근 HISTORY_LIMIT 개. CLI 가 스스로 넣은 메시지(source system)는 뺀다.
export function historyOf(items: TimelineItem[] | undefined): string[] {
  const sent = (items ?? []).filter((i): i is Extract<TimelineItem, { kind: "user" }> => i.kind === "user" && i.source !== "system").map((i) => i.shown ?? i.text);
  return sent.slice(-HISTORY_LIMIT);
}

// 위 화살표는 이전 입력으로, 아래 화살표는 다시 최근 쪽으로 간다. index 가 null 이면 기록을 넘기지 않는 중이다.
// 끝(가장 최근)에서 한 번 더 아래로 가면 null 로 돌아와 입력창이 비워진다(글이 비어 있을 때만 이 기능이 켜지므로 비워진 상태가 원래 상태다).
export function stepHistory(length: number, index: number | null, direction: "up" | "down"): number | null {
  if (length === 0) return null;
  if (direction === "up") return index === null ? length - 1 : Math.max(index - 1, 0);
  if (index === null) return null;
  return index + 1 >= length ? null : index + 1;
}

// `/` 와 `@` 메뉴를 여는 글자 위치. 슬래시 명령은 입력의 맨 앞에서만, 멘션은 줄 앞이나 공백 뒤에서만 시작한다.
export type Trigger = { kind: "slash" | "mention"; query: string; start: number; end: number };

export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  if (before.startsWith("/") && !/\s/.test(before)) return { kind: "slash", query: before.slice(1), start: 0, end: caret };
  // 문장 중간의 `/스킬` 도 목록을 연다("보고서에 /writing"). 앞이 공백일 때만이라 `src/a` 같은 경로 중간에서는 열지 않고, `/Users/` 처럼 두 번째 `/` 를 치면 닫힌다.
  const slash = before.lastIndexOf("/");
  if (slash > 0 && /\s/.test(before[slash - 1]) && !/[\s/]/.test(before.slice(slash + 1)) && slash > before.lastIndexOf("@")) return { kind: "slash", query: before.slice(slash + 1), start: slash, end: caret };
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const token = before.slice(at + 1);
  if (/\s/.test(token)) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  return { kind: "mention", query: token, start: at, end: caret };
}

// 메뉴에서 고른 것으로 트리거 글자를 바꾼다. 돌려주는 caret 은 바뀐 글 바로 뒤.
export function applyTrigger(text: string, trigger: Trigger, replacement: string): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + replacement + text.slice(trigger.end);
  return { text: next, caret: trigger.start + replacement.length };
}

export function applyMention(text: string, trigger: Trigger, path: string): { text: string; caret: number } {
  const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  const after = text.slice(trigger.end);
  // 글 끝이거나 글이 바로 이어 붙으면 공백을 하나 넣고, 뒤가 이미 공백이면 그 공백을 쓴다. 캐럿은 그 공백 뒤(줄바꿈 앞이면 멘션 바로 뒤)다.
  const gap = after === "" || !/^\s/.test(after) ? " " : "";
  const caret = trigger.start + mention.length + (gap || after[0] !== "\n" ? 1 : 0);
  return { text: text.slice(0, trigger.start) + mention + gap + after, caret };
}

// 칩으로 따로 붙이는 파일(편집기에서 줄 범위를 고른 파일)은 글에서 `@검색어` 만 지운다. 양쪽이 모두 공백이면 하나만 남겨 이중 공백이 생기지 않게 한다.
export function removeMention(text: string, trigger: Trigger): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const trimmed = /\s$/.test(before) && /^[ \t]/.test(after) ? after.slice(1) : after;
  return { text: before + trimmed, caret: before.length };
}

// 마크다운 목록과 인용은 줄바꿈(Shift+Enter)에서 다음 줄로 이어진다. `- `, `* `, `+ `, `1. `, `- [ ] `, `> ` 와 앞 들여쓰기를 그대로 잇고, 번호는 하나 올린다.
// 마커만 있는 빈 항목에서 줄바꿈하면 마커를 지우고 목록을 끝낸다. 이을 것이 없으면 null 이라 브라우저 기본 줄바꿈을 쓴다.
export function continueMarkdown(text: string, caret: number): { text: string; caret: number } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  const match = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))(\s+)(\[[ xX]\]\s+)?/.exec(line);
  if (!match) return null;
  const [marker, indent, bullet, num, delimiter, quote, gap, task] = match;
  if (line.length === marker.length) {
    // 빈 항목: 마커를 지우고 그 줄을 비운다
    return { text: text.slice(0, lineStart) + text.slice(caret), caret: lineStart };
  }
  const next = num ? `${Number(num) + 1}${delimiter}` : (bullet ?? quote);
  const insert = `\n${indent}${next}${gap}${task ? "[ ] " : ""}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}
