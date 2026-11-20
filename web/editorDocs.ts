import { isolateHistory } from "@codemirror/commands";
import { Prec, type Extension, type StateCommand, type Text } from "@codemirror/state";
import { redo, undo } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import type { FormatResult, FormatterId } from "../shared/protocol";
import { confirmAction, confirmDialog, promptText } from "./ConfirmDialog";
import { currentEditorOptions } from "./editorOptions";
import { copyName } from "./fileKind";
import { FV } from "./fileViewStrings";
import { absolutePath, lspFormat, notifySaved } from "./lsp";
import { notify } from "./notices";
import { rpc } from "./rpc";
import { hasSaveTransforms, saveTransformChanges, type SaveTransformPhase } from "./saveTransforms";
import { activeKeyOfGroup, closeTab, fileTabKey, flash, getState, openFile, openUntitled, pinEditorTab, refreshGit, replaceTab, setDirty, setState } from "./store";
import { S } from "./strings";
import { groupOf } from "./editorGroups";
import { baseKeyOf, sameContent } from "./editorTabs";
import { forwardUpdate, mirrored, noHistory, ownerOnlyHistory, runOwnerHistory, shouldForward, skipMirror, type MirrorHost, type MirrorTarget } from "./viewMirror";
import { foreignFolder } from "./tabFolder";
import { WORKSPACE_CHANGED_EVENT } from "./workspaceEvents";
import { clearHotExit, noteHotChanged, planHotRestore, registerHotReader, saveHotExitNow, type HotDoc } from "./windowState";
import { hint } from "./hint";
import { announce } from "./announce";

// 에디터에서 연 파일의 편집 상태: 저장된 내용(savedDoc), 디스크에서 마지막으로 본 수정 시각, 디스크와 충돌 중인지.
// 에디터 컴포넌트(web/Editor.tsx)가 뷰를 만들 때 등록하고 지울 때 뺀다. 저장, 닫을 때 확인, 포맷, 디스크 변경 확인이 여기 있다.

export type DocConflict = { diskText: string; mtimeMs: number | null; reason: "external" | "save"; comparing: boolean };

type DocEntry = {
  key: string;
  workspaceId: string;
  // 이름 없는 탭은 null
  path: string | null;
  view: EditorView;
  savedDoc: Text;
  // 저장한 때의 줄끝. Text.eq 는 줄끝을 보지 않으므로 줄끝만 바꿔도 수정됨이 되도록 따로 든다.
  savedBreak: string;
  baseMtimeMs: number | null;
  checking: boolean;
  // FIX6C: 확인하는 동안 또 요청이 오면(복원 직후처럼) 끝난 뒤 한 번 더 본다
  recheck: boolean;
};

const docs = new Map<string, DocEntry>();
const conflicts = new Map<string, DocConflict>();
const conflictListeners = new Set<() => void>();

// FIX6A: 문서마다 저장 안 한 내용을 hot exit 보관소(web/windowState.ts)에 내주는 읽기 등록을 해제하는 함수
const hotOff = new Map<string, () => void>();

export function attachDoc(entry: Omit<DocEntry, "checking" | "recheck" | "savedBreak">) {
  const doc: DocEntry = { ...entry, savedBreak: entry.view.state.lineBreak, checking: false, recheck: false };
  docs.set(entry.key, doc);
  adoptSibling(doc);
  hotOff.get(entry.key)?.();
  hotOff.set(
    entry.key,
    registerHotReader(entry.key, () => hotDocOf(entry.key)),
  );
  syncDirty(entry.key);
}

// --- 같은 파일의 여러 보기 ---


const siblingsOf = (doc: DocEntry) => [...docs.values()].filter((d) => d !== doc && d.path !== null && d.path === doc.path && d.workspaceId === doc.workspaceId);

// 이 키의 파일을 연 보기들 중 먼저 연 것(Map 은 넣은 순서대로 돈다). 아직 attachDoc 전인 보기는 기본 키가 같은 문서로 같은 파일을 찾는다.
function historyOwner(key: string): DocEntry | null {
  const self = docs.get(key);
  const same = [...docs.values()].filter((d) => d.path !== null && (self ? d.path === self.path && d.workspaceId === self.workspaceId : baseKeyOf(d.key) === baseKeyOf(key)));
  return same[0] ?? null;
}

const isHistoryOwner = (key: string) => {
  const owner = historyOwner(key);
  return !owner || owner.key === key;
};

// owner 가 아닌 보기에서 실행한 undo, redo 를 owner 에 보낸다. 보낼 곳이 없으면(owner 가 이 보기이거나 같은 파일이 하나뿐) false 로 두어 평소 키맵이 받게 한다.
function routeHistory(key: string, view: EditorView, command: StateCommand) {
  const owner = historyOwner(key);
  if (!owner || owner.key === key) return false;
  runOwnerHistory(command, ownerHost(owner.view), view);
  return true;
}

// 숨겨진 탭(display none)의 보기는 스크롤 위치를 읽을 수 없어 되돌릴 스크롤 기록을 만들지 않는다
function ownerHost(view: EditorView): MirrorHost {
  return {
    get state() {
      return view.state;
    },
    dispatch: (...specs) => view.dispatch(...specs),
    scrollSnapshot: () => (view.dom.offsetParent === null ? undefined : view.scrollSnapshot()),
  };
}

export function docMirror(key: string): Extension {
  return [
    ownerOnlyHistory(() => isHistoryOwner(key)),
    // 기본 historyKeymap(Mod-z, Mod-y, 맥은 Mod-Shift-z)과 같은 키. ⌘U 같은 선택 기록은 보기마다 따로 둔다.
    Prec.highest([
      keymap.of([
        { key: "Mod-z", run: (view) => routeHistory(key, view, undo), preventDefault: true },
        { key: "Mod-y", mac: "Mod-Shift-z", run: (view) => routeHistory(key, view, redo), preventDefault: true },
        { linux: "Ctrl-Shift-z", run: (view) => routeHistory(key, view, redo), preventDefault: true },
      ]),
      // 편집 메뉴의 Undo, Redo 는 Chromium 이 historyUndo, historyRedo 입력으로 보낸다(history() 가 같은 입력을 받는다)
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          const command = event.inputType === "historyUndo" ? undo : event.inputType === "historyRedo" ? redo : null;
          if (!command || !routeHistory(key, view, command)) return false;
          event.preventDefault();
          return true;
        },
      }),
    ]),
    EditorView.updateListener.of((update) => {
      if (!shouldForward(update)) return;
      const self = docs.get(key);
      if (!self) return;
      const owner = historyOwner(key);
      forwardUpdate(update, [...siblingsOf(self).map((other) => ({ host: other.view, keepsHistory: other === owner })), ...mirrorTargets(self.workspaceId, self.path, update.view)]);
    }),
  ];
}

// --- diff 의 수정본 쪽 보기 ---

// diff 의 수정본 쪽은 파일 탭이 아니라서 저장, 충돌, 닫을 때 확인, hot exit 에는 들지 않는다. 하지만 같은 파일의 같은 문서이므로 내용은 따라간다:
// 열린 파일 탭의 변경(저장 안 한 것 포함)이 흘러 들어오고, diff 안의 변경(덩어리 Undo)은 파일 탭으로 흘러 나간다. 이것이 없으면 두 보기가 서로 다른 글이 되어 서버(LSP)가 가진 글과 어긋난다.
// 되돌리기 기록은 파일 탭의 owner 가 가진다(keepsHistory 는 늘 false).
type MirrorView = { workspaceId: string; path: string; view: EditorView };
const mirrorViews = new Set<MirrorView>();

// 같은 파일을 가리키는지는 절대 경로로 본다(diff 의 path 는 절대 경로일 수 있고 파일 탭의 path 는 작업 폴더 기준이다).
const sameFile = (aWorkspace: string, aPath: string, bWorkspace: string, bPath: string) => aWorkspace === bWorkspace && absolutePath(aWorkspace, aPath) === absolutePath(bWorkspace, bPath);

function mirrorTargets(workspaceId: string, path: string | null, except: EditorView): MirrorTarget[] {
  if (path === null) return [];
  return [...mirrorViews].filter((m) => m.view !== except && sameFile(m.workspaceId, m.path, workspaceId, path)).map((m) => ({ host: m.view, keepsHistory: false }));
}

// 이 파일의 열린 파일 탭에 저장 안 한 내용이 있으면 그 글. diff 가 디스크 내용 대신 이 글로 시작해야 서버가 가진 글(탭의 버퍼)과 같다. 없으면 null(디스크를 읽는다).
export function unsavedTextOf(workspaceId: string, path: string): string | null {
  for (const doc of docs.values()) {
    if (doc.path !== null && isDirty(doc) && sameFile(doc.workspaceId, doc.path, workspaceId, path)) return doc.view.state.doc.toString();
  }
  return null;
}

// diff 보기를 같은 문서 묶음에 넣는다. 돌려주는 함수가 뺀다.
export function attachMirrorView(workspaceId: string, path: string, view: EditorView): () => void {
  const entry: MirrorView = { workspaceId, path, view };
  mirrorViews.add(entry);
  return () => void mirrorViews.delete(entry);
}

// diff 의 수정본 쪽 보기가 스스로 만든 변경(덩어리 Undo)을 같은 파일의 모든 파일 탭과 다른 diff 보기에 흘려 보낸다.
export function mirrorOnly(workspaceId: string, path: string): Extension {
  return EditorView.updateListener.of((update) => {
    if (!shouldForward(update)) return;
    const owner = historyOwnerOf(workspaceId, path);
    const docTargets = [...docs.values()].filter((d) => d.path !== null && sameFile(d.workspaceId, d.path, workspaceId, path)).map((d) => ({ host: d.view, keepsHistory: d === owner }));
    forwardUpdate(update, [...docTargets, ...mirrorTargets(workspaceId, path, update.view)]);
  });
}

function historyOwnerOf(workspaceId: string, path: string): DocEntry | null {
  return [...docs.values()].find((d) => d.path !== null && sameFile(d.workspaceId, d.path, workspaceId, path)) ?? null;
}

// 새로 열린 보기를 같은 파일을 먼저 연 보기의 내용(저장 안 한 편집 포함)과 저장 기준으로 맞춘다.
function adoptSibling(doc: DocEntry) {
  const sibling = siblingsOf(doc)[0];
  if (!sibling) return;
  if (!doc.view.state.doc.eq(sibling.view.state.doc)) doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: sibling.view.state.doc }, annotations: [mirrored.of(true), noHistory] });
  doc.savedDoc = sibling.savedDoc;
  doc.savedBreak = sibling.savedBreak;
  doc.baseMtimeMs = sibling.baseMtimeMs;
}

// 이 탭이 닫혀도 같은 파일의 다른 탭이 남는지. 남으면 저장 안 한 내용이 그 탭에 그대로 있다.
function hasOtherView(key: string, closing: readonly string[]) {
  const tabs = getState().tabs;
  const tab = tabs.find((t) => t.key === key);
  return !!tab && tabs.some((t) => t.key !== key && !closing.includes(t.key) && sameContent(t, tab));
}

export function detachDoc(key: string, view: EditorView) {
  if (docs.get(key)?.view !== view) return;
  hotOff.get(key)?.();
  hotOff.delete(key);
  docs.delete(key);
  setConflict(key, null);
  setFlags(key, null);
}

// Q2: 디스크에서 지워진 파일(탭에 취소선과 (Deleted)), 이 프로세스가 쓸 수 없는 파일(배너). 둘 다 없으면 항목을 지운다.
export type DocFlags = { deleted?: boolean; readOnly?: boolean };
const flags = new Map<string, DocFlags>();
const NO_FLAGS: DocFlags = {};

function setFlags(key: string, patch: DocFlags | null) {
  const next = patch === null ? NO_FLAGS : { ...(flags.get(key) ?? NO_FLAGS), ...patch };
  const before = flags.get(key) ?? NO_FLAGS;
  if (!!before.deleted === !!next.deleted && !!before.readOnly === !!next.readOnly) return;
  if (next.deleted || next.readOnly) flags.set(key, next);
  else flags.delete(key);
  for (const listener of conflictListeners) listener();
}

export function setDocReadOnly(key: string, readOnly: boolean) {
  setFlags(key, { readOnly });
}

export function useDocFlags(key: string): DocFlags {
  return useSyncExternalStore(
    (listener) => {
      conflictListeners.add(listener);
      return () => conflictListeners.delete(listener);
    },
    () => flags.get(key) ?? NO_FLAGS,
  );
}

export function docView(key: string) {
  return docs.get(key)?.view ?? null;
}

// 줄끝 바꾸기가 쓴다: 같은 파일을 연 모든 보기(자기 포함)
export function viewsOfSameFile(view: EditorView): EditorView[] {
  const self = [...docs.values()].find((d) => d.view === view);
  return self ? [self.view, ...siblingsOf(self).map((d) => d.view)] : [view];
}

export function refocusActiveEditor() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = getState().activeTabKey;
      if (active) docView(active)?.focus();
    }),
  );
}

// 뷰의 문서가 바뀔 때마다 부른다. 저장된 내용과 같은지로 수정 표시를 정한다(이름 없는 탭은 내용이 있으면 수정으로 본다).
export function syncDirty(key: string) {
  const doc = docs.get(key);
  if (!doc) return;
  setDirty(key, isDirty(doc));
  noteHotChanged();
}

const isDirty = (doc: DocEntry) => (doc.path === null ? doc.view.state.doc.length > 0 : !doc.savedDoc.eq(doc.view.state.doc) || doc.savedBreak !== doc.view.state.lineBreak);

// 수정이 있는 문서의 내용. 깨끗하면 null(보관할 것이 없다).
function hotDocOf(key: string): HotDoc | null {
  const doc = docs.get(key);
  return doc && isDirty(doc) ? { text: textOf(doc.view), baseMtimeMs: doc.baseMtimeMs } : null;
}

// 앱을 껐을 때 저장 안 했던 내용을 방금 디스크에서 읽은 문서 위에 올린다. 디스크 내용이 저장된 내용으로 남으므로 수정 표시가 켜진다.
// 보관한 뒤 파일이 밖에서 바뀌었다면(수정 시각이 다르면) 덮어쓰지 않고 충돌 안내를 띄운다.
export function restoreHotDoc(key: string, hot: HotDoc) {
  const doc = docs.get(key);
  if (!doc) return;
  const diskText = textOf(doc.view);
  const { externalChange } = planHotRestore(doc.baseMtimeMs, hot);
  const next = doc.view.state.toText(hot.text.replace(/\r?\n/g, doc.view.state.lineBreak));
  doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: next }, annotations: [noHistory, skipMirror.of(true)] });
  syncDirty(key);
  if (externalChange) setConflict(key, { diskText, mtimeMs: doc.baseMtimeMs, reason: "external", comparing: false });
}

function setConflict(key: string, conflict: DocConflict | null) {
  if (conflict) conflicts.set(key, conflict);
  else if (!conflicts.delete(key)) return;
  for (const listener of conflictListeners) listener();
}

export function useDocConflict(key: string) {
  return useSyncExternalStore(
    (listener) => {
      conflictListeners.add(listener);
      return () => conflictListeners.delete(listener);
    },
    () => conflicts.get(key) ?? null,
  );
}

export function toggleCompare(key: string) {
  const conflict = conflicts.get(key);
  if (conflict) setConflict(key, { ...conflict, comparing: !conflict.comparing });
}

const nameOf = (key: string) => {
  const tab = getState().tabs.find((t) => t.key === key);
  return !tab ? key : tab.kind === "untitled" ? S.untitledName(tab.n) : "path" in tab ? tab.path.slice(tab.path.lastIndexOf("/") + 1) : key;
};

function textOf(view: EditorView) {
  return view.state.sliceDoc(0, view.state.doc.length);
}

// --- 저장 ---

// 같은 탭의 저장은 앞의 저장이 끝난 뒤에 시작한다. 겹치면 둘째 저장이 첫 저장 전의 수정 시각(baseMtimeMs)을 보내 서버가 바깥 변경으로 보고 거절한다(⌘S 를 빨리 두 번, 저장 중 닫기에서 Save).
const savesInFlight = new Map<string, Promise<boolean>>();

export function saveTab(key: string, options: { force?: boolean } = {}): Promise<boolean> {
  const before = savesInFlight.get(key);
  const run = before ? before.catch(() => false).then(() => saveTabNow(key, options)) : saveTabNow(key, options);
  savesInFlight.set(key, run);
  const done = () => {
    if (savesInFlight.get(key) === run) savesInFlight.delete(key);
  };
  run.then(done, done);
  return run;
}

async function saveTabNow(key: string, options: { force?: boolean }): Promise<boolean> {
  const doc = docs.get(key);
  const tab = getState().tabs.find((t) => t.key === key);
  if (!doc || !tab) return false;
  if (tab.kind === "untitled") return saveUntitled(doc, tab.n);
  if (doc.path === null) return false;
  const path = doc.path;
  if (!(await confirmForeignSave(key, doc.workspaceId, path))) return false;
  if (await formatOnSaveEnabled(doc.workspaceId)) {
    applySaveTransforms(doc.view, "beforeFormat");
    await formatDoc(key, false, true);
    applySaveTransforms(doc.view, "afterFormat");
  } else {
    applySaveTransforms(doc.view, "all");
  }
  const snapshot = doc.view.state.doc;
  const savedBreak = doc.view.state.lineBreak;
  const text = textOf(doc.view);
  try {
    const result = await rpc.call("files.save", { workspaceId: doc.workspaceId, path, text, baseMtimeMs: doc.baseMtimeMs, force: options.force });
    if (!result.saved && result.conflict === "readonly") {
      reportReadOnly(key);
      return false;
    }
    if (!result.saved) {
      const disk = await rpc.call("files.read", { workspaceId: doc.workspaceId, path });
      setConflict(key, { diskText: disk.text ?? "", mtimeMs: result.mtimeMs, reason: "save", comparing: false });
      // 배너가 보이는 탭이면 배너가 같은 말을 한다. 보이지 않는 탭(다른 탭에서 저장한 경우)만 알림으로 알린다.
      if (!isTabShown(key)) flash(S.saveFailedNewer(nameOf(key)), "error");
      return false;
    }
    doc.baseMtimeMs = result.mtimeMs;
    doc.savedDoc = snapshot;
    doc.savedBreak = savedBreak;
    // 같은 파일의 다른 보기도 같은 내용이면 저장된 것으로 본다
    for (const other of siblingsOf(doc)) {
      if (!other.view.state.doc.eq(snapshot)) continue;
      other.savedDoc = snapshot;
      other.savedBreak = savedBreak;
      other.baseMtimeMs = result.mtimeMs;
      setConflict(other.key, null);
      syncDirty(other.key);
    }
    pinEditorTab(key);
    setConflict(key, null);
    if (flags.get(key)?.deleted) void refreshFileList(doc.workspaceId);
    setFlags(key, { deleted: false, readOnly: false });
    syncDirty(key);
    notifySaved(doc.workspaceId, path, text);
    refreshAgentsOf(doc.workspaceId);
    return true;
  } catch (error) {
    flash(S.saveFailed(nameOf(key), (error as Error).message), "error");
    return false;
  }
}

// 저장 때 본문을 고치는 설정(files.trimTrailingWhitespace, insertFinalNewline, trimFinalNewlines)을 되돌리기 한 단계로 적용한다.
function applySaveTransforms(view: EditorView, phase: SaveTransformPhase) {
  const options = currentEditorOptions();
  if (view.state.readOnly || !hasSaveTransforms(options, phase)) return;
  const changes = saveTransformChanges(view.state.doc, options, phase);
  if (changes.empty) return;
  view.dispatch({ changes, annotations: isolateHistory.of("full"), userEvent: "save.transform" });
}

// 이 탭의 에디터가 화면에 보이는지: 에디터 칸이 열려 있고 그 그룹의 활성 탭이다.
function isTabShown(key: string) {
  const s = getState();
  const tab = s.tabs.find((t) => t.key === key);
  if (!tab || !(s.layoutMode === "editor" || s.rightOpen)) return false;
  return activeKeyOfGroup(s, groupOf(tab)) === key;
}

// 읽기 전용 파일 저장: 시스템 오류 원문(EACCES) 대신 사람이 읽는 문구와 Save As 단추를 낸다. 단추는 닫을 때까지 남는다.
function reportReadOnly(key: string) {
  setFlags(key, { readOnly: true });
  // 배너(Save As 단추 포함)가 보이는 탭이면 알림은 같은 말을 되풀이하므로 띄우지 않는다.
  if (isTabShown(key)) return;
  notify({ message: FV.readOnlyMessage, severity: "error", key: `readonly:${key}`, actions: [{ label: FV.saveAs, run: () => void saveAsTab(key), primary: true }] });
}

// 이 탭의 내용을 다른 경로에 새 파일로 저장하고 탭을 그 파일로 바꾼다. 원래 파일은 그대로 둔다.
export async function saveAsTab(key: string): Promise<boolean> {
  const doc = docs.get(key);
  if (!doc) return false;
  const path = await promptText(
    FV.saveAsTitle,
    FV.saveAsConfirm,
    { initial: doc.path ? copyName(doc.path) : "", placeholder: S.saveAsPlaceholder, label: FV.saveAsTitle, validate: (value) => validateNewPath(doc.workspaceId, value) },
    S.saveAsDetail,
  );
  if (path === null) return false;
  const clean = path.trim().replace(/^\.\//, "");
  applySaveTransforms(doc.view, "all");
  try {
    await rpc.call("files.create", { workspaceId: doc.workspaceId, path: clean, kind: "file", text: textOf(doc.view) });
  } catch (error) {
    flash(S.saveFailed(clean, (error as Error).message), "error");
    return false;
  }
  await refreshFileList(doc.workspaceId);
  replaceTab(key, { key: fileTabKey(doc.workspaceId, clean), kind: "file", workspaceId: doc.workspaceId, path: clean });
  refreshAgentsOf(doc.workspaceId);
  return true;
}

// 지금 세션의 저장소 밖 파일(워크트리 세션에서 연 메인 체크아웃의 탭 등)은 저장 전에 한 번 확인한다. 같은 탭과 세션 폴더 조합은 다시 묻지 않는다.
const confirmedForeign = new Set<string>();

async function confirmForeignSave(key: string, workspaceId: string, path: string) {
  const state = getState();
  const pane = state.panes.find((p) => p.id === state.activePaneId);
  const agent = pane?.kind === "agent" ? state.agents.find((a) => a.id === pane.agentId) : undefined;
  const found = foreignFolder(state.workspaces.find((w) => w.id === workspaceId)?.dir, path, agent, agent ? state.gitInfo[agent.id]?.repoRoot : null);
  if (!found) return true;
  const id = `${key}|${found.session}`;
  if (confirmedForeign.has(id)) return true;
  if (!(await confirmAction(S.saveOutsideSessionConfirm(found.file, found.session), S.save))) return false;
  confirmedForeign.add(id);
  return true;
}

// 이름 없는 탭 저장: 경로를 묻고, 이미 있는 이름이면 입력 아래에 오류를 보인 채 다시 받는다. 만든 파일은 같은 자리의 파일 탭이 된다.
async function saveUntitled(doc: DocEntry, n: number): Promise<boolean> {
  const path = await promptText(
    S.saveAsTitle,
    S.saveAsConfirm,
    { initial: "", placeholder: S.saveAsPlaceholder, label: S.saveAsTitle, validate: (value) => validateNewPath(doc.workspaceId, value) },
    S.saveAsDetail,
  );
  if (path === null) return false;
  const clean = path.trim().replace(/^\.\//, "");
  applySaveTransforms(doc.view, "all");
  try {
    await rpc.call("files.create", { workspaceId: doc.workspaceId, path: clean, kind: "file", text: textOf(doc.view) });
  } catch (error) {
    flash(S.saveFailed(S.untitledName(n), (error as Error).message), "error");
    return false;
  }
  await refreshFileList(doc.workspaceId);
  replaceTab(doc.key, { key: fileTabKey(doc.workspaceId, clean), kind: "file", workspaceId: doc.workspaceId, path: clean });
  refreshAgentsOf(doc.workspaceId);
  return true;
}

// 새 파일, 폴더, 다른 이름으로 저장 입력이 같이 쓰는 이름 검사. 문제가 있으면 오류 문장, 없으면 null.
export async function validateNewPath(workspaceId: string, value: string): Promise<string | null> {
  const name = value.trim();
  if (!name) return S.newEntryEmpty;
  if (name.startsWith("/") || name.split("/").some((part) => part === "..")) return S.newEntryInvalid;
  const exists = await rpc.call("files.stat", { workspaceId, path: name }).then((r) => r.mtimeMs !== null).catch(() => false);
  return exists ? S.newEntryExists(name) : null;
}

export async function refreshFileList(workspaceId: string) {
  const [files, dirs] = await Promise.all([rpc.call("files.list", { workspaceId }), rpc.call("files.dirs", { workspaceId }).catch(() => [] as string[])]);
  setState((s) => ({ files: { ...s.files, [workspaceId]: files }, emptyDirs: { ...s.emptyDirs, [workspaceId]: dirs } }));
}

function refreshAgentsOf(workspaceId: string) {
  for (const agent of getState().agents) if (agent.workspaceId === workspaceId) void refreshGit(agent.id);
}

export async function resolveConflict(key: string) {
  if (!docs.get(key) || !conflicts.get(key)) return;
  await saveTab(key, { force: true });
}

function replaceWholeDoc(doc: DocEntry, text: string, mtimeMs: number | null) {
  const next = doc.view.state.toText(text.replace(/\r?\n/g, doc.view.state.lineBreak));
  // 디스크에서 가져온 내용이 저장된 내용이므로 먼저 맞춰 둔다(그래야 문서가 바뀐 뒤 수정 표시가 켜지지 않는다)
  doc.savedDoc = next;
  doc.savedBreak = doc.view.state.lineBreak;
  doc.baseMtimeMs = mtimeMs;
  doc.view.dispatch({ changes: { from: 0, to: doc.view.state.doc.length, insert: next }, annotations: [noHistory, skipMirror.of(true)] });
  syncDirty(doc.key);
}


// --- 디스크 변경 ---

// 열린 파일이 디스크에서 바뀌었는지 본다. 편집이 없으면 조용히 새 내용으로 바꾸고, 편집이 있으면 충돌 안내를 띄운다(내용은 건드리지 않는다).
export async function checkDisk(key: string) {
  const doc = docs.get(key);
  if (!doc || doc.path === null) return;
  if (doc.checking) {
    doc.recheck = true;
    return;
  }
  doc.checking = true;
  try {
    const { mtimeMs } = await rpc.call("files.stat", { workspaceId: doc.workspaceId, path: doc.path });
    if (docs.get(key) !== doc) return;
    // 바깥에서 지워진 파일은 내용을 그대로 두고 탭에만 표시한다. 다시 생기면 표시를 거둔다.
    setFlags(key, { deleted: mtimeMs === null });
    if (mtimeMs === null || mtimeMs === doc.baseMtimeMs) return;
    const disk = await rpc.call("files.read", { workspaceId: doc.workspaceId, path: doc.path });
    // 바이너리가 된 파일은 본문이 빈 글로 온다. 그대로 받으면 깨끗한 탭이 빈 문서로 바뀌어, 고쳐 저장하는 순간 원래 파일을 덮는다. 지금 글을 두고 저장 때의 충돌 확인에 맡긴다.
    if (disk.text === null || disk.binary || docs.get(key) !== doc) return;
    const diskDoc = doc.view.state.toText(disk.text.replace(/\r?\n/g, doc.view.state.lineBreak));
    if (diskDoc.eq(doc.savedDoc)) {
      doc.baseMtimeMs = disk.mtimeMs ?? mtimeMs;
      return;
    }
    if (doc.savedDoc.eq(doc.view.state.doc)) {
      // 같은 파일의 다른 보기도 같이 바꾼다. 바꾸기는 다른 보기로 흘려 보내지 않아서(skipMirror), 이 보기만 새 글이 되면 그 사이 친 글이 옛 글을 가진 보기에 엉뚱한 자리로 흘러간다.
      // 이미 새 글로 바뀐 보기(자기 확인이 먼저 끝난 보기)는 건드리지 않는다.
      const stale = siblingsOf(doc).filter((other) => other.savedDoc.eq(doc.savedDoc) && other.savedDoc.eq(other.view.state.doc));
      for (const target of [doc, ...stale]) replaceWholeDoc(target, disk.text, disk.mtimeMs ?? mtimeMs);
      return;
    }
    if (doc.view.state.doc.eq(diskDoc)) {
      doc.savedDoc = diskDoc;
      doc.savedBreak = doc.view.state.lineBreak;
      doc.baseMtimeMs = disk.mtimeMs ?? mtimeMs;
      syncDirty(key);
      return;
    }
    const known = conflicts.get(key);
    if (known?.mtimeMs !== mtimeMs) setConflict(key, { diskText: disk.text, mtimeMs, reason: "external", comparing: known?.comparing ?? false });
  } catch {
    // 읽지 못하면 다음 기회에 다시 본다
  } finally {
    doc.checking = false;
    if (doc.recheck) {
      doc.recheck = false;
      void checkDisk(key);
    }
  }
}

export function checkAllDisks() {
  for (const key of docs.keys()) void checkDisk(key);
}

let started = false;
// FIX6A: 창을 닫거나 앱을 끌 때 저장 안 한 변경은 막지 않고 hot exit 보관소에 남겨 다음 실행에서 되살린다.
// Reload Window 와 Restart Daemon 은 저장 안 한 변경을 앱 안 확인 창으로 먼저 묻고, 사용자가 버려도 된다고 확인했으면 보관하지 않는다(setKeepUnsavedOnUnload(false)).
let keepUnsavedOnUnload = true;
export const setKeepUnsavedOnUnload = (keep: boolean) => {
  keepUnsavedOnUnload = keep;
};
// 에이전트의 도구가 끝날 때(Bash 로 파일을 바꾼 경우까지), 창이 다시 포커스를 받을 때, 창이 닫힐 때를 지킨다.
export function initEditorDocs() {
  if (started) return;
  started = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  rpc.onEvent((event) => {
    if (event.type !== "timelineUpsert" || event.item.kind !== "tool" || event.item.status !== "done") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(checkAllDisks, 300);
  });
  window.addEventListener("focus", checkAllDisks);
  // FIX6B: 데몬의 파일 감시가 알리는 바깥 변화(git merge --abort, checkout 등). 창 포커스 없이도 그 폴더의 열린 파일을 디스크와 맞춘다.
  window.addEventListener(WORKSPACE_CHANGED_EVENT, (event) => {
    const ids = (event as CustomEvent<{ workspaceIds: string[] }>).detail.workspaceIds;
    for (const [key, doc] of docs) if (ids.includes(doc.workspaceId)) void checkDisk(key);
  });
  // beforeunload 에서 막지 않는다(막으면 메인의 will-prevent-unload 대화상자가 종료를 멈춘다). 동기로 보관만 한다. pagehide 는 beforeunload 가 안 불리는 길의 보험이다.
  const keepOrDiscard = () => (keepUnsavedOnUnload ? saveHotExitNow() : clearHotExit());
  window.addEventListener("beforeunload", keepOrDiscard);
  window.addEventListener("pagehide", keepOrDiscard);
}

// --- 닫기 ---

// 탭을 닫는다. 저장 안 한 변경이 있으면 Save, Don't Save, Cancel 을 묻고, 취소하면 아무것도 닫지 않는다. 닫았으면 true.
export async function requestCloseTabs(keys: string[]): Promise<boolean> {
  const dirty = keys.filter((key) => getState().dirtyTabs[key] && !hasOtherView(key, keys));
  if (dirty.length) {
    const names = dirty.map(nameOf);
    const choice = await confirmDialog({
      title: dirty.length === 1 ? S.saveChangesTitle(names[0]) : S.saveChangesTitleMany(dirty.length),
      detail: dirty.length === 1 ? S.saveChangesDetail : `${names.join("\n")}\n\n${S.saveChangesDetail}`,
      buttons: [S.dontSave, S.cancel, S.save],
      severity: "warning",
    });
    if (choice === null || choice === 1) return false;
    if (choice === 2) for (const key of dirty) if (!(await saveTab(key))) return false;
  }
  for (const key of keys) closeTab(key);
  return true;
}

export function requestCloseTab(key: string) {
  return requestCloseTabs([key]);
}

// --- 포맷 ---

async function formatOnSaveEnabled(workspaceId: string) {
  try {
    return (await rpc.call("format.config", { workspaceId })).formatOnSave;
  } catch {
    return false;
  }
}

const FORMATTER_NAME: Record<FormatterId, string> = { eslint: "ESLint", prettier: "Prettier", oxc: "oxfmt", tsserver: "TypeScript" };

// 활성 탭을 포맷한다(Format Document, Format Selection).
export function formatActive(selection: boolean) {
  const s = getState();
  const tab = s.tabs.find((t) => t.key === s.activeTabKey);
  if (!tab || tab.kind !== "file") {
    hint(S.formatNeedsEditor);
    return Promise.resolve(false);
  }
  return formatDoc(tab.key, selection, false);
}

export async function formatDoc(key: string, selection: boolean, silent: boolean, formatter?: FormatterId, options: { range?: { from: number; to: number }; quiet?: boolean } = {}): Promise<boolean> {
  const doc = docs.get(key);
  if (!doc || doc.path === null) return false;
  const { view, path } = doc;
  const before = view.state.doc;
  const text = textOf(view);
  let range: { from: number; to: number } | undefined;
  if (selection && options.range) {
    range = options.range;
  } else if (selection) {
    const main = view.state.selection.main;
    // 선택이 비어 있으면 커서가 있는 줄을 선택으로 본다
    const line = view.state.doc.lineAt(main.head);
    range = main.empty ? { from: line.from, to: line.to } : { from: main.from, to: main.to };
  }
  let result;
  try {
    result = await rpc.call("format.run", { workspaceId: doc.workspaceId, path, text, range, formatter });
  } catch (error) {
    if (!options.quiet) flash(S.formatFailed((error as Error).message), "error");
    return false;
  }
  if (result.problem) {
    if (!options.quiet) reportFormatProblem(key, result, selection, silent);
    return false;
  }
  let formatted = result.text;
  if (formatted === null && result.formatter === "tsserver") {
    try {
      formatted = await lspFormat(view, range);
    } catch (error) {
      if (!options.quiet) flash(S.formatFailed((error as Error).message), "error");
      return false;
    }
  }
  if (formatted === null) return false;
  if (view.state.doc !== before) {
    if (!options.quiet) flash(S.formatDocChanged);
    return false;
  }
  const changed = applyMinimalText(view, formatted);
  const label = FORMATTER_NAME[result.formatter ?? "tsserver"];
  // 바뀐 글이 에디터에 보이므로 낭독만 하고, 이미 정돈된 파일이면 커서 위에 말해 준다
  if (!silent && changed) announce(S.formattedWith(label));
  else if (!silent) hint(S.formatUnchanged(label), view);
  return changed;
}

// editor.formatOnPaste: 붙여 넣은 범위를 포맷한다. 못 하는 언어나 포맷터 문제는 알리지 않고 지나간다(web/formatOnPaste.ts 가 부른다).
export function formatPastedRange(view: EditorView, range: { from: number; to: number }) {
  const doc = [...docs.values()].find((entry) => entry.view === view);
  if (!doc || doc.path === null || !currentEditorOptions().formatOnPaste) return;
  void formatDoc(doc.key, true, true, undefined, { range: { from: Math.min(range.from, view.state.doc.length), to: Math.min(range.to, view.state.doc.length) }, quiet: true });
}

function reportFormatProblem(key: string, result: FormatResult, selection: boolean, silent: boolean) {
  const { problem, language } = result;
  if (!problem) return;
  if (problem.kind === "none") {
    if (!silent) hint(S.noFormatter(language), docs.get(key)?.view);
    return;
  }
  const message =
    problem.kind === "cannotFormat"
      ? S.formatCannot(problem.extension, language)
      : problem.kind === "selectionUnsupported"
        ? S.formatWholeOnly(problem.extension, language)
        : problem.kind === "unavailable"
          ? S.formatUnavailable(problem.extensionId)
          : problem.kind === "unsupported"
            ? S.formatUnsupported(problem.extension)
            : S.formatAmbiguous(language);
  const actions = [
    { label: S.formatConfigure, run: () => setState({ overlay: { kind: "status", section: "format" } }), primary: true },
    ...(result.alternatives ?? []).map((choice) => ({ label: S.formatWith(choice.label), run: () => void formatDoc(key, selection, false, choice.formatter) })),
  ];
  notify({
    message,
    severity: "warning",
    detail: problem.kind === "cannotFormat" && problem.detail ? problem.detail : undefined,
    actions,
    key: `format:${language}:${problem.kind}`,
    ...(silent ? { autoHideMs: SAVE_NOTICE_MS } : {}),
  });
}

const SAVE_NOTICE_MS = 15_000;

// 새 텍스트와 지금 문서의 공통 앞뒤를 빼고 가운데만 바꾼다. 커서와 스크롤, 되돌리기 기록이 통째로 바뀌지 않는다.
export function applyMinimalText(view: EditorView, newText: string): boolean {
  const lineBreak = view.state.lineBreak;
  const next = newText.replace(/\r?\n/g, lineBreak);
  const current = textOf(view);
  if (next === current) return false;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)) {
    endCurrent--;
    endNext--;
  }
  // 서러게이트 쌍을 반으로 가르지 않는다
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  if (endCurrent < current.length && isLowSurrogate(current.charCodeAt(endCurrent))) {
    endCurrent++;
    endNext++;
  }
  view.dispatch({ changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) }, userEvent: "input.format" });
  return true;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// --- 새 파일 ---

export function newUntitled() {
  openUntitled();
}

// 새 파일 경로를 묻고 만든 뒤 에디터 탭으로 연다(팔레트의 New File...). 폴더는 열린 세션의 폴더다.
export async function newFileByPath(workspaceId: string, initial = "") {
  const path = await promptText(
    S.newFileTitle,
    S.newFileConfirm,
    { initial, placeholder: S.saveAsPlaceholder, label: S.newFileTitle, validate: (value) => validateNewPath(workspaceId, value) },
    S.newFileDetail,
  );
  if (path === null) return;
  await createEntry(workspaceId, path.trim().replace(/^\.\//, ""), "file");
}

// 파일이나 폴더를 만든다. 파일이면 에디터 탭으로 연다. 실패하면 알림을 띄우고 false.
export async function createEntry(workspaceId: string, path: string, kind: "file" | "folder"): Promise<boolean> {
  try {
    await rpc.call("files.create", { workspaceId, path, kind });
  } catch (error) {
    flash(S.newEntryFailed((error as Error).message), "error");
    return false;
  }
  await refreshFileList(workspaceId);
  if (kind === "file") {
    openFile({ workspaceId, path });
  }
  refreshAgentsOf(workspaceId);
  return true;
}
