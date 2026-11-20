import { useSyncExternalStore } from "react";
import type { Note } from "../shared/notes";
import { rpc } from "./rpc";
import { confirmDialog } from "./ConfirmDialog";
import { flash, getState, openNotes, setState, subscribe } from "./store";
import { S } from "./strings";

// NOTES: 메모장의 화면 상태와 저장. 목록과 본문의 정본은 데몬(notes.*)이고, 여기는 목록 사본, 열린 메모, 편집 중인 글(초안)과 저장 상태를 든다.
// store.ts 와 분리한 자체 저장소다(notionStore.ts, prStore.ts 와 같은 방식). 가운데 화면 전환(centerView)만 store.ts 에 맡긴다.
// 저장 규칙은 1. 입력이 멈춘 뒤 SAVE_DELAY_MS 가 지나면 저장, 2. 다른 메모로 옮기거나 화면을 떠나거나 창이 숨겨지면 바로 저장, 3. 실패하면 글을 초안에 그대로 두고 간격을 늘려 다시 시도한다.

export type NoteSave = "saved" | "pending" | "saving" | "error";

type NotesUi = {
  notes: Note[] | null;
  loadError: string | null;
  query: string;
  // 검색어가 있을 때 데몬이 돌려준 결과(본문 검색). 없으면 null 이라 전체 목록을 보인다.
  results: Note[] | null;
  openId: string | null;
  save: NoteSave;
  // 다른 창이 바꾼 글을 편집기에 덮어쓰라는 요청. nonce 가 바뀔 때마다 한 번 적용한다.
  remote: { id: string; text: string; nonce: number } | null;
  // 새 메모를 만들었거나 빈 메모가 이미 열려 있을 때 편집기에 포커스를 주라는 신호
  focusNonce: number;
};

// 초안: 편집기에 있는 글(text)과 데몬이 마지막으로 받은 글(savedText). 둘이 다르면 저장할 것이 있다.
type Draft = { text: string; savedText: string; rev: string; timer: ReturnType<typeof setTimeout> | null; saving: Promise<void> | null; failures: number; deleting: boolean };

export const SAVE_DELAY_MS = 300;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 15_000;
const SEARCH_DELAY_MS = 150;
const PREFS_KEY = "agent-nav:notes-ui";

type Prefs = { openId: string | null; listScroll: number };

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { openId: typeof saved.openId === "string" ? saved.openId : null, listScroll: typeof saved.listScroll === "number" && saved.listScroll >= 0 ? saved.listScroll : 0 };
  } catch {
    return { openId: null, listScroll: 0 };
  }
}

let prefs = loadPrefs();

function savePrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 저장이 막힌 환경에서는 이번 실행 동안만 유지
  }
}

export const savedListScroll = () => prefs.listScroll;
export const saveListScroll = (listScroll: number) => savePrefs({ listScroll });

let ui: NotesUi = { notes: null, loadError: null, query: "", results: null, openId: prefs.openId, save: "saved", remote: null, focusNonce: 0 };
const listeners = new Set<() => void>();
const drafts = new Map<string, Draft>();
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchToken = 0;

function set(patch: Partial<NotesUi>) {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
}

export function useNotes<T>(select: (ui: NotesUi) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(ui),
  );
}

// 화면에 보이는 목록: 검색 결과가 있으면 그것, 없으면 전체
export const visibleNotes = (state: NotesUi): Note[] | null => state.results ?? state.notes;

const isDirty = (d: Draft) => d.text !== d.savedText;
const failMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isUnknownNote = (error: unknown) => failMessage(error).startsWith("Unknown note");

function statusOf(d: Draft | undefined): NoteSave {
  if (!d) return "saved";
  if (d.saving) return "saving";
  if (isDirty(d)) return d.failures > 0 ? "error" : "pending";
  return "saved";
}

function refreshStatus(id: string) {
  if (id !== ui.openId) return;
  const next = statusOf(drafts.get(id));
  if (next !== ui.save) set({ save: next });
}

// --- 목록 ---

export async function refreshNotes() {
  try {
    const notes = await rpc.call("notes.list", {});
    set({ notes, loadError: null });
    afterListChange(notes);
    if (ui.query.trim()) void runSearch();
  } catch (error) {
    // 옛 데몬은 notes.list 를 모른다. 화면은 데몬을 다시 시작하라는 안내를 보인다.
    set({ notes: null, loadError: /unknown method|not found/i.test(failMessage(error)) ? S.notesNeedsDaemon : S.notesLoadFailed(failMessage(error)) });
  }
}

// 목록이 바뀐 뒤: 열린 메모가 지워졌거나 다른 창이 바꿨는지 보고, 열린 메모가 없으면 가장 최근 메모를 연다.
function afterListChange(list: Note[]) {
  const id = ui.openId;
  if (id) {
    const note = list.find((n) => n.id === id);
    const draft = drafts.get(id);
    if (!note) {
      if (!draft?.deleting) void handleDeleted(id);
    } else if (draft && note.rev !== draft.rev && !isDirty(draft) && !draft.saving) void pullRemote(id);
  }
  if (!ui.openId && getState().centerView === "notes" && list.length > 0) void openNote(list[0]!.id);
}

// 지워진 메모를 열어 둔 상태. 고치던 글이 있으면 잃지 않도록 새 메모로 옮기고, 없으면 이웃 메모로 간다.
async function handleDeleted(id: string) {
  const draft = drafts.get(id);
  if (id !== ui.openId) {
    drafts.delete(id);
    return;
  }
  if (draft && isDirty(draft) && draft.text.trim() !== "") {
    if (draft.timer) clearTimeout(draft.timer);
    drafts.delete(id);
    try {
      const doc = await rpc.call("notes.create", { text: draft.text });
      drafts.set(doc.id, { text: doc.text, savedText: doc.text, rev: doc.rev, timer: null, saving: null, failures: 0, deleting: false });
      flash(S.notesDeletedElsewhere);
      selectOpen(doc.id);
    } catch (error) {
      // 새 메모도 못 만들면 초안을 그대로 둔다. 다음 입력이나 재시도가 다시 시도한다.
      drafts.set(id, draft);
      draft.failures += 1;
      scheduleSave(id, draft);
      flash(S.notesCreateFailed(failMessage(error)));
    }
    return;
  }
  drafts.delete(id);
  const list = visibleNotes(ui) ?? [];
  selectOpen(list.find((n) => n.id !== id)?.id ?? null);
}

async function pullRemote(id: string) {
  try {
    const doc = await rpc.call("notes.get", { id });
    const draft = drafts.get(id);
    // 읽는 사이에 이쪽에서 고쳤거나 저장이 시작되면 이쪽 글이 이긴다
    if (!draft || isDirty(draft) || draft.saving || doc.rev === draft.rev) return;
    draft.text = doc.text;
    draft.savedText = doc.text;
    draft.rev = doc.rev;
    set({ remote: { id, text: doc.text, nonce: (ui.remote?.nonce ?? 0) + 1 } });
  } catch {
    // 그 사이에 지워졌다면 곧 오는 notes 이벤트가 처리한다
  }
}

// --- 열린 메모 ---

function selectOpen(id: string | null) {
  set({ openId: id, save: statusOf(id ? drafts.get(id) : undefined) });
  savePrefs({ openId: id });
}

// 편집기가 처음 뜰 때 부른다. 초안이 있으면(저장 실패로 남았거나 방금 만든 메모) 그 글, 없으면 데몬에서 읽는다.
export async function loadNoteText(id: string): Promise<string> {
  const existing = drafts.get(id);
  if (existing) return existing.text;
  const doc = await rpc.call("notes.get", { id });
  const draft = drafts.get(id);
  if (draft) return draft.text;
  drafts.set(id, { text: doc.text, savedText: doc.text, rev: doc.rev, timer: null, saving: null, failures: 0, deleting: false });
  return doc.text;
}

// 편집 중인 최신 글(저장 전이어도). 대화 첨부가 파일보다 먼저 읽는다. 초안이 없으면 null.
export const draftText = (id: string): string | null => drafts.get(id)?.text ?? null;

export async function openNote(id: string | null) {
  const previous = ui.openId;
  if (previous === id) return;
  selectOpen(id);
  if (previous) await leaveNote(previous);
}

// 메모를 떠난다: 바로 저장하고, 아무것도 안 쓴 빈 메모는 지운다(빈 메모가 쌓이지 않게).
async function leaveNote(id: string) {
  await flushNote(id);
  const draft = drafts.get(id);
  if (!draft || id === ui.openId) return;
  if (draft.text.trim() === "" && !isDirty(draft) && !draft.deleting) {
    draft.deleting = true;
    try {
      await rpc.call("notes.delete", { id });
    } catch {
      // 이미 지워졌으면 목록이 곧 맞춰진다
    }
  }
  if (!isDirty(draft)) drafts.delete(id);
}

export async function createNote(): Promise<void> {
  // 아직 아무것도 안 쓴 메모가 열려 있으면 새로 만들지 않고 그 메모에 포커스를 준다
  const open = ui.openId ? drafts.get(ui.openId) : undefined;
  if (open && open.text.trim() === "") {
    set({ focusNonce: ui.focusNonce + 1 });
    return;
  }
  try {
    const doc = await rpc.call("notes.create", {});
    drafts.set(doc.id, { text: doc.text, savedText: doc.text, rev: doc.rev, timer: null, saving: null, failures: 0, deleting: false });
    if (ui.query) setQuery("");
    await openNote(doc.id);
    set({ focusNonce: ui.focusNonce + 1 });
  } catch (error) {
    flash(S.notesCreateFailed(failMessage(error)));
  }
}

// 팔레트의 "Notes: New Note". 화면을 열고 목록을 읽은 뒤 만든다.
export async function createNoteAndOpen() {
  openNotes();
  if (ui.notes === null) await refreshNotes();
  await createNote();
}

export async function deleteNote(id: string) {
  const choice = await confirmDialog({ title: S.notesDeleteTitle, detail: S.notesDeleteDetail, buttons: [S.cancel, S.notesDeleteConfirm], danger: [1] });
  if (choice !== 1) return;
  const draft = drafts.get(id);
  // 지우는 동안 편집기가 보내는 저장이 지워진 메모를 되살리지 않게 막는다
  if (draft) {
    draft.deleting = true;
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = null;
    await draft.saving;
  }
  try {
    // 마지막으로 쓴 글까지 파일에 있어야 휴지통에 그대로 들어간다
    if (draft && isDirty(draft)) await rpc.call("notes.save", { id, text: draft.text });
    await rpc.call("notes.delete", { id });
  } catch (error) {
    if (draft) draft.deleting = false;
    if (!isUnknownNote(error)) {
      flash(S.notesDeleteFailed(failMessage(error)));
      return;
    }
  }
  drafts.delete(id);
  if (id === ui.openId) {
    const list = visibleNotes(ui) ?? [];
    const index = list.findIndex((n) => n.id === id);
    const next = list[index + 1] ?? list[index - 1];
    selectOpen(next?.id ?? null);
  }
}

// --- 저장 ---

// 편집기가 글이 바뀔 때마다 부른다.
export function editNote(id: string, text: string) {
  const draft = drafts.get(id);
  if (!draft || draft.deleting || draft.text === text) return;
  draft.text = text;
  draft.failures = 0;
  if (draft.saving) {
    refreshStatus(id);
    return;
  }
  if (!isDirty(draft)) {
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = null;
    refreshStatus(id);
    return;
  }
  scheduleSave(id, draft);
}

function scheduleSave(id: string, draft: Draft) {
  if (draft.timer) clearTimeout(draft.timer);
  const delay = draft.failures > 0 ? Math.min(RETRY_BASE_MS * 2 ** (draft.failures - 1), RETRY_MAX_MS) : SAVE_DELAY_MS;
  draft.timer = setTimeout(() => void flushNote(id), delay);
  refreshStatus(id);
}

// 기다리지 않고 지금 저장한다. 저장 중이면 그 저장이 끝난 뒤, 그 사이에 더 고쳤으면 한 번 더 저장한다.
export function flushNote(id: string | null = ui.openId): Promise<void> {
  const draft = id ? drafts.get(id) : undefined;
  if (!id || !draft || draft.deleting) return Promise.resolve();
  if (draft.timer) clearTimeout(draft.timer);
  draft.timer = null;
  if (draft.saving) return draft.saving.then(() => (isDirty(draft) ? flushNote(id) : undefined));
  if (!isDirty(draft)) {
    refreshStatus(id);
    return Promise.resolve();
  }
  const sent = draft.text;
  draft.saving = (async () => {
    try {
      const note = await rpc.call("notes.save", { id, text: sent });
      draft.savedText = sent;
      draft.rev = note.rev;
      draft.failures = 0;
    } catch (error) {
      draft.failures += 1;
      if (isUnknownNote(error) && !draft.deleting) {
        draft.saving = null;
        void handleDeleted(id);
        return;
      }
      if (draft.failures === 1) flash(S.notesSaveFailedFlash(failMessage(error)), "warning");
    }
    draft.saving = null;
    // 저장하는 사이에 더 썼거나 실패했으면 다시 저장을 예약한다. 열려 있지 않은 깨끗한 메모의 초안은 버린다.
    if (isDirty(draft)) scheduleSave(id, draft);
    else {
      if (id !== ui.openId) drafts.delete(id);
      refreshStatus(id);
    }
  })();
  refreshStatus(id);
  return draft.saving;
}

// 창이 숨겨지거나 닫히기 직전에 저장할 것을 모두 보낸다. 웹소켓 전송은 동기라 페이지가 사라져도 요청은 나간다.
function flushAll() {
  for (const id of drafts.keys()) void flushNote(id);
}

// --- 검색 ---

export function setQuery(query: string) {
  set({ query, ...(query.trim() ? {} : { results: null }) });
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  if (query.trim()) searchTimer = setTimeout(() => void runSearch(), SEARCH_DELAY_MS);
}

async function runSearch() {
  const query = ui.query;
  if (!query.trim()) return;
  const token = ++searchToken;
  try {
    const results = await rpc.call("notes.list", { query });
    if (token === searchToken && query === ui.query) set({ results });
  } catch {
    // 검색이 안 되면 전체 목록을 그대로 보인다
  }
}

// --- 시작 ---

export function initNotes() {
  rpc.onStatus((connected) => {
    if (connected) void refreshNotes();
  });
  rpc.onEvent((event) => {
    if (event.type !== "notes") return;
    set({ notes: event.notes, loadError: null });
    afterListChange(event.notes);
    if (ui.query.trim()) void runSearch();
  });
  // 메모장 화면을 떠나면(Esc, 사이드바, 세션 열기 어느 쪽이든) 열린 메모를 바로 저장한다. 다시 들어오면 목록을 새로 읽어 바깥 변경을 따라간다.
  let wasNotes = getState().centerView === "notes";
  subscribe(() => {
    const isNotes = getState().centerView === "notes";
    if (isNotes === wasNotes) return;
    wasNotes = isNotes;
    if (!isNotes) {
      const id = ui.openId;
      if (!id) return;
      void flushNote(id).then(() => {
        const draft = drafts.get(id);
        // 아무것도 안 쓴 메모는 지우고 다음에 열 때 가장 최근 메모가 열리게 한다
        if (draft && draft.text.trim() === "" && !isDirty(draft) && ui.openId === id && getState().centerView !== "notes") {
          draft.deleting = true;
          void rpc.call("notes.delete", { id }).catch(() => undefined);
          drafts.delete(id);
          selectOpen(null);
        }
      });
    } else {
      void refreshNotes();
    }
  });
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}
