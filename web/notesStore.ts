import { useSyncExternalStore } from "react";
import type { Note } from "../shared/notes";
import { rpc } from "./rpc";
import { confirmDialog } from "./ConfirmDialog";
import { flash, getState, openNotes, subscribe } from "./store";
import { S } from "./strings";

export type NoteSave = "saved" | "pending" | "saving" | "error";

type NotesUi = {
  notes: Note[] | null;
  loadError: string | null;
  query: string;
  results: Note[] | null;
  openId: string | null;
  save: NoteSave;
  remote: { id: string; text: string; nonce: number } | null;
  focusNonce: number;
};

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

export async function refreshNotes() {
  try {
    const notes = await rpc.call("notes.list", {});
    set({ notes, loadError: null });
    afterListChange(notes);
    if (ui.query.trim()) void runSearch();
  } catch (error) {
    set({ notes: null, loadError: /unknown method|not found/i.test(failMessage(error)) ? S.notesNeedsDaemon : S.notesLoadFailed(failMessage(error)) });
  }
}

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
    if (!draft || isDirty(draft) || draft.saving || doc.rev === draft.rev) return;
    draft.text = doc.text;
    draft.savedText = doc.text;
    draft.rev = doc.rev;
    set({ remote: { id, text: doc.text, nonce: (ui.remote?.nonce ?? 0) + 1 } });
  } catch {
  }
}

function selectOpen(id: string | null) {
  set({ openId: id, save: statusOf(id ? drafts.get(id) : undefined) });
  savePrefs({ openId: id });
}

export async function loadNoteText(id: string): Promise<string> {
  const existing = drafts.get(id);
  if (existing) return existing.text;
  const doc = await rpc.call("notes.get", { id });
  const draft = drafts.get(id);
  if (draft) return draft.text;
  drafts.set(id, { text: doc.text, savedText: doc.text, rev: doc.rev, timer: null, saving: null, failures: 0, deleting: false });
  return doc.text;
}

export const draftText = (id: string): string | null => drafts.get(id)?.text ?? null;

export async function openNote(id: string | null) {
  const previous = ui.openId;
  if (previous === id) return;
  selectOpen(id);
  if (previous) await leaveNote(previous);
}

async function leaveNote(id: string) {
  await flushNote(id);
  const draft = drafts.get(id);
  if (!draft || id === ui.openId) return;
  if (draft.text.trim() === "" && !isDirty(draft) && !draft.deleting) {
    draft.deleting = true;
    try {
      await rpc.call("notes.delete", { id });
    } catch {
    }
  }
  if (!isDirty(draft)) drafts.delete(id);
}

export async function createNote(): Promise<void> {
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

export async function createNoteAndOpen() {
  openNotes();
  if (ui.notes === null) await refreshNotes();
  await createNote();
}

export async function deleteNote(id: string) {
  const choice = await confirmDialog({ title: S.notesDeleteTitle, detail: S.notesDeleteDetail, buttons: [S.cancel, S.notesDeleteConfirm], danger: [1] });
  if (choice !== 1) return;
  const draft = drafts.get(id);
  if (draft) {
    draft.deleting = true;
    if (draft.timer) clearTimeout(draft.timer);
    draft.timer = null;
    await draft.saving;
  }
  try {
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
    if (isDirty(draft)) scheduleSave(id, draft);
    else {
      if (id !== ui.openId) drafts.delete(id);
      refreshStatus(id);
    }
  })();
  refreshStatus(id);
  return draft.saving;
}

function flushAll() {
  for (const id of drafts.keys()) void flushNote(id);
}

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
  }
}

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
