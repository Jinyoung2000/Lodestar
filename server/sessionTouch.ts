import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Agent, ChangedFile, RestorePlan, ShellNote, TimelineItem, UndoCheck, UndoSkip } from "../shared/protocol";
import * as gitOps from "./git";
import { hasForkBase, forkBaseOriginal } from "./forkBase";
import { lastTurnChanges, lastTurnOriginal } from "./lastTurn";
import { compareWith } from "./snapshotDiff";
import { HOME, type Store } from "./store";

// 이 세션의 에이전트가 만진 파일 장부. Session 범위(입력창 칩, 사이드바 숫자, Changes 패널), Last Turn, Undo 가 같이 쓴다.
// 폴더 전체를 비교하지 않는 이유: 같은 폴더의 다른 세션과 사용자의 바깥 수정, 그 사이 커밋이 이 세션의 변경으로 섞여 Undo All 이 남의 작업을 지웠다(dogfood 4회차 1번).
// 항목 하나는 "에이전트가 처음 만지기 직전 내용(before)" 과 "에이전트가 마지막으로 쓴 직후 내용의 해시(after)" 다.
// 근거는 편집 도구(Edit, Write, MultiEdit, NotebookEdit)의 PreToolUse, PostToolUse 훅이 1차고, Bash 로 바뀐 파일은 턴 끝에 귀속 규칙(endTurn)으로 넣는다.
const DIR = join(HOME, "touched");
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_BYTES = 2 * 1024 * 1024;
const ABSENT = "absent";
export const TOUCH_BASE = "touched";

export type Touch = {
  before: string | null;
  // 에이전트의 마지막 쓰기 직후 내용의 해시(파일이 없으면 ABSENT). 모르면(옛 세션에서 옮겨 온 항목, 너무 큰 파일) 없다.
  after?: string;
  // 편집 도구가 시작했고 아직 끝났다는 신호를 못 받았다
  pending?: true;
  // 에이전트의 쓰기 사이에 다른 손이 같은 파일을 고쳤고 그 위에 에이전트가 또 썼다. 되돌리면 그 손의 변경까지 지우게 된다.
  mixed?: true;
  via: "edit" | "bash";
};

type Ledger = {
  files: Record<string, Touch>;
  // 마지막 턴이 만진 파일(절대 경로). 데몬을 다시 띄워도 Last Turn 범위가 남게 저장한다.
  turnFiles: string[];
  // Session 범위가 이 장부로 목록을 만드는 세션인지. worktree 세션은 Branch 와 Session 이 같아서 장부는 Undo 확인과 Last Turn 에만 쓴다.
  listsSession: boolean;
  // 장부가 없던 옛 세션에서 타임라인으로 옮겨 만들었다(after 를 모른다)
  migrated?: true;
  // FIX5-0: 같은 폴더의 다른 세션과 시간이 겹쳐 Bash 귀속을 건너뛴 턴 중 장부에 없는 변경이 남은 턴. 최근 몇 개만.
  shellNotes?: { at: string; title: string }[];
};
const SHELL_NOTE_KEEP = 5;

type TurnState = { start: number; files: Set<string>; bash: boolean; ended: boolean };

const ledgers = new Map<string, Ledger>();
const loading = new Map<string, Promise<Ledger | null>>();
const turns = new Map<string, TurnState>();
// 시간대가 겹친 다른 세션의 턴을 알아보려는 기록. 세션마다 최근 몇 개만 둔다.
const intervals = new Map<string, { start: number; end: number | null; cwd: string }[]>();
const INTERVAL_KEEP = 20;
const dirty = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

export const hashOf = (content: Buffer | null) => (content === null ? ABSENT : createHash("sha1").update(content).digest("hex"));

// 장부가 다루는 세션: 폴더가 있는 일반 세션. 피드백 세션은 자기 기준이 따로 있다.
export const tracksTouches = (agent: Pick<Agent, "workspaceId" | "feedbackId">) => agent.workspaceId !== null && !agent.feedbackId;

const listsSessionOf = (agent: Pick<Agent, "worktree" | "forkBased" | "startCommit">) => agent.forkBased === true || (!agent.worktree && !!agent.startCommit);

// 파일의 지금 상태. 내용과 해시. 너무 크거나 NUL 이 든(이진) 파일은 장부로 다루지 않는다(문자열로 옮기면 내용이 망가진다).
export async function readState(path: string): Promise<{ text: string | null; hash: string } | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.length > MAX_BYTES || buffer.includes(0)) return undefined;
    return { text: buffer.toString("utf8"), hash: hashOf(buffer) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { text: null, hash: ABSENT } : undefined;
  }
}

// 이 세션의 장부를 읽는다(없으면 만든다). 장부가 없던 옛 세션은 타임라인의 편집 도구 호출로 한 번 옮겨 만든다.
export async function ensureLedger(agent: Agent, store: Store): Promise<Ledger | null> {
  if (!tracksTouches(agent)) return null;
  const known = ledgers.get(agent.id);
  if (known) return known;
  const pendingLoad = loading.get(agent.id);
  if (pendingLoad) return pendingLoad;
  const started = load(agent, store).finally(() => loading.delete(agent.id));
  loading.set(agent.id, started);
  return started;
}

// 장부가 이미 메모리나 디스크에 있는지(옛 세션의 이주 없이). 시험과 호출부의 빠른 판단용.
export function hasLedger(agentId: string) {
  return ledgers.has(agentId) || existsSync(join(DIR, `${agentId}.json`));
}

async function load(agent: Agent, store: Store): Promise<Ledger> {
  const file = join(DIR, `${agent.id}.json`);
  if (existsSync(file)) {
    try {
      const ledger = JSON.parse(await readFile(file, "utf8")) as Ledger;
      ledgers.set(agent.id, ledger);
      return ledger;
    } catch {
      // 깨진 장부는 새로 시작한다(옛 세션처럼 타임라인에서 다시 만든다)
    }
  }
  const ledger = await migrate(agent, store);
  ledgers.set(agent.id, ledger);
  save(agent.id);
  return ledger;
}

// 옛 세션: 타임라인에서 편집 도구가 만진 경로를 모으고, 기준은 forkBase 스냅샷이나 세션 시작 커밋의 내용으로 잡는다. 에이전트의 마지막 쓰기는 알 수 없어 after 가 없다.
async function migrate(agent: Agent, store: Store): Promise<Ledger> {
  const listsSession = listsSessionOf(agent);
  const ledger: Ledger = { files: {}, turnFiles: [], listsSession, migrated: true };
  if (!listsSession) return ledger;
  const root = await rootOf(agent.cwd);
  const base = hasForkBase(agent.id) ? null : agent.startCommit ? await gitOps.sessionBase(agent.cwd, agent.startCommit) : null;
  for (const path of editedPaths(agent, store.timeline(agent.id), root)) {
    const before = hasForkBase(agent.id) ? await forkBaseOriginal(agent, path) : await gitOps.original(agent.cwd, base, path);
    if (before !== null && before.length > MAX_BYTES) continue;
    ledger.files[path] = { before, via: "edit" };
  }
  return ledger;
}

// 타임라인의 편집 도구 호출이 가리킨 파일(절대 경로, 저장소 안). 순서대로 한 번씩.
export function editedPaths(agent: Pick<Agent, "cwd">, items: TimelineItem[], root: string): string[] {
  const found = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || !EDIT_TOOLS.has(item.name)) continue;
    const absolute = pathOfInput(agent.cwd, item.input);
    if (absolute && insideRoot(root, absolute)) found.add(absolute);
  }
  return [...found];
}

function pathOfInput(cwd: string, input: Record<string, unknown>) {
  const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function insideRoot(root: string, path: string) {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// 편집 도구가 파일을 쓰기 직전(PreToolUse). 처음 만지는 파일이면 그때 내용을 기준으로 남긴다. 기록이 바뀌었으면 true.
export async function recordBeforeEdit(agent: Agent, store: Store, toolName: string, input: Record<string, unknown>): Promise<boolean> {
  if (!tracksTouches(agent) || !EDIT_TOOLS.has(toolName)) return false;
  const absolute = pathOfInput(agent.cwd, input);
  if (!absolute) return false;
  if (!insideRoot(await rootOf(agent.cwd), absolute)) return false;
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return false;
  const state = await readState(absolute);
  const entry = ledger.files[absolute];
  if (!entry) {
    // 너무 크거나 이진인 파일은 장부에 넣지 못한다: 목록과 Undo 에서 빠진다
    if (!state) return false;
    ledger.files[absolute] = { before: state.text, after: state.hash, pending: true, via: "edit" };
  } else {
    // 에이전트가 마지막으로 쓴 뒤 다른 손이 고친 파일에 또 쓰는 것이면 되돌릴 때 그 변경이 같이 사라진다
    if (!entry.pending && (!state || entry.after !== state.hash)) entry.mixed = true;
    entry.pending = true;
  }
  turnOf(agent.id).files.add(absolute);
  save(agent.id);
  return true;
}

// 편집 도구가 끝난 직후(PostToolUse). 지금 디스크가 에이전트가 쓴 내용이다.
export async function recordAfterEdit(agent: Agent, store: Store, toolName: string, input: Record<string, unknown>) {
  if (!tracksTouches(agent) || !EDIT_TOOLS.has(toolName)) return;
  const absolute = pathOfInput(agent.cwd, input);
  const ledger = await ensureLedger(agent, store);
  const entry = absolute ? ledger?.files[absolute] : undefined;
  if (!absolute || !entry) return;
  const state = await readState(absolute);
  if (state) entry.after = state.hash;
  else delete entry.after;
  delete entry.pending;
  save(agent.id);
}

// Bash 도구를 불렀다(PreToolUse). 턴 끝에 Bash 로 바뀐 파일을 귀속할지 정하는 근거다.
export function noteBash(agentId: string) {
  turnOf(agentId).bash = true;
}

function turnOf(agentId: string): TurnState {
  let turn = turns.get(agentId);
  if (!turn || turn.ended) {
    turn = { start: Date.now(), files: new Set(), bash: false, ended: false };
    turns.set(agentId, turn);
  }
  return turn;
}

// 턴이 시작될 때(메시지를 보낼 때마다). 끼어든 메시지처럼 도는 중에 또 불려도 시간대는 처음 시작부터다.
export function beginTurn(agent: Pick<Agent, "id" | "cwd">) {
  const turn = turns.get(agent.id);
  if (!turn || turn.ended) {
    turns.set(agent.id, { start: Date.now(), files: new Set(), bash: false, ended: false });
    const list = intervals.get(agent.id) ?? [];
    list.push({ start: Date.now(), end: null, cwd: agent.cwd });
    intervals.set(agent.id, list.slice(-INTERVAL_KEEP));
  }
}

// 턴이 끝났다(정상, 중단, 오류 모두). 두 번 불려도 한 번만 일한다.
// Bash 귀속 규칙: Bash 를 한 번도 안 불렀으면 없다. 같은 저장소 루트에서 다른 세션의 턴이 이 턴과 시간대가 겹쳤으면 누가 바꾼 것인지 단정할 수 없어 하지 않는다(편집 도구 기록만 남는다).
// 겹침이 없으면 턴 시작 때 스냅샷과 지금 디스크를 비교해 바뀐 파일을 장부에 넣는다.
export async function endTurn(agent: Agent, store: Store) {
  const turn = turns.get(agent.id);
  if (!turn || turn.ended) return;
  turn.ended = true;
  const list = intervals.get(agent.id);
  const last = list?.[list.length - 1];
  if (last && last.end === null) last.end = Date.now();
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return;
  const sharedTurn = turn.bash && (await overlapsOtherSession(agent, turn.start));
  const bashOwn = turn.bash && !sharedTurn;
  if (sharedTurn) await noteUncountedShell(agent, store, ledger);
  for (const path of turn.files) {
    const entry = ledger.files[path];
    if (!entry) continue;
    // 끝났다는 신호를 못 받은 편집은 이 턴 안에서 일어난 것으로 본다. 같은 턴의 Bash(포맷터 등)가 이어서 쓴 것도 이 세션의 쓰기다(겹친 턴이 아닐 때만).
    if (entry.pending || bashOwn) {
      const state = await readState(path);
      if (state) entry.after = state.hash;
      else delete entry.after;
      delete entry.pending;
    }
  }
  if (bashOwn) await attributeBash(agent, store, ledger, turn);
  ledger.turnFiles = [...turn.files];
  save(agent.id);
}

async function attributeBash(agent: Agent, store: Store, ledger: Ledger, turn: TurnState) {
  const root = await rootOf(agent.cwd);
  const { files } = await lastTurnChanges(agent, store);
  for (const file of files) {
    if (ledger.files[file.path] || !insideRoot(root, file.path)) continue;
    const before = await lastTurnOriginal(agent, store, file.path);
    const state = await readState(file.path);
    if (before === undefined || !state || (before !== null && (before.length > MAX_BYTES || before.includes("\0")))) continue;
    ledger.files[file.path] = { before, after: state.hash, via: "bash" };
    turn.files.add(file.path);
  }
}

// FIX5-0: 겹친 턴이라 Bash 귀속을 건너뛰었다. 그 턴 끝 디스크에 장부에 없는 변경이 있으면 "일부를 세지 못했다" 는 기록을 남긴다(규칙 자체는 그대로).
// 남의 변경과 이 세션의 Bash 변경을 구분하지 못하므로 개수는 말하지 않고, 어느 턴이었는지만 남긴다.
async function noteUncountedShell(agent: Agent, store: Store, ledger: Ledger) {
  if (!ledger.listsSession) return;
  const root = await rootOf(agent.cwd);
  const { files } = await lastTurnChanges(agent, store);
  if (!files.some((f) => !ledger.files[f.path] && insideRoot(root, f.path))) return;
  const prompt = [...store.timeline(agent.id)].reverse().find((i) => i.kind === "user" && i.source !== "system");
  const first = prompt?.kind === "user" ? (prompt.shown ?? prompt.text).trim().split("\n")[0] : "";
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  ledger.shellNotes = [...(ledger.shellNotes ?? []), { at: new Date().toISOString(), title }].slice(-SHELL_NOTE_KEEP);
}

// 이 턴(start 부터 지금까지)과 시간대가 겹친 다른 세션의 턴이 같은 저장소 루트에 있었는지. 이미 끝난 턴도 시간대가 겹치면 센다.
async function overlapsOtherSession(agent: Agent, start: number) {
  const mine = await rootOf(agent.cwd);
  const now = Date.now();
  for (const [otherId, list] of intervals) {
    if (otherId === agent.id) continue;
    for (const interval of list) {
      if (interval.start >= now || (interval.end ?? Infinity) <= start) continue;
      if ((await rootOf(interval.cwd)) === mine) return true;
    }
  }
  return false;
}

const roots = new Map<string, string>();
async function rootOf(cwd: string) {
  const known = roots.get(cwd);
  if (known) return known;
  const root = (await gitOps.repoRoot(cwd)) ?? cwd;
  roots.set(cwd, root);
  return root;
}

// 장부의 파일이 에이전트의 마지막 쓰기 뒤에 바뀌었는지. 되돌리기 전에 이것으로 남의 변경을 지키고, 목록에는 표시로 보인다.
async function modifiedSince(entry: Touch, path: string) {
  if (entry.pending) return false;
  if (entry.mixed || entry.after === undefined) return true;
  const state = await readState(path);
  return !state || state.hash !== entry.after;
}

// Session 범위의 변경 파일: 장부의 파일 중 지금 디스크가 기준과 다른 것. 기준이 곧 에이전트가 처음 만지기 직전 내용이다.
export async function touchedChanges(agent: Agent, store: Store): Promise<{ base: string | null; files: ChangedFile[]; shellNote?: ShellNote }> {
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return { base: null, files: [] };
  const files = await compareWith(agent, Object.keys(ledger.files), (path) => Promise.resolve(ledger.files[path].before));
  const flagged = await Promise.all(files.map(async (file): Promise<ChangedFile> => ((await modifiedSince(ledger.files[file.path], file.path)) ? { ...file, modifiedSince: true } : file)));
  return { base: TOUCH_BASE, files: flagged, ...(ledger.shellNotes?.length ? { shellNote: { turns: ledger.shellNotes } } : {}) };
}

// 장부에 있는 파일의 기준 내용(에이전트가 처음 만지기 직전). 장부에 없으면 undefined.
export async function touchedOriginal(agent: Agent, store: Store, absolute: string): Promise<string | null | undefined> {
  const ledger = await ensureLedger(agent, store);
  const entry = ledger?.files[absolute];
  return entry ? entry.before : undefined;
}

export async function isTouched(agent: Agent, store: Store, absolute: string) {
  const ledger = await ensureLedger(agent, store);
  return !!ledger?.files[absolute];
}

// Last Turn 범위가 볼 파일: 마지막 턴에서 이 세션이 만진 것. 장부를 못 쓰는 세션(폴더 없음, 피드백)은 null 이라 제한이 없다.
export async function lastTurnPaths(agent: Agent, store: Store): Promise<Set<string> | null> {
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return null;
  const live = turns.get(agent.id);
  return new Set(live ? live.files : ledger.turnFiles);
}

// Last Turn 범위의 변경: 턴 시작 때와 비교하되(lastTurnChanges) 이 세션이 만진 파일만 남긴다. 턴 요약 카드도 같은 계산이다.
export async function touchedLastTurn(agent: Agent, store: Store): Promise<{ base: string | null; files: ChangedFile[] }> {
  const result = await lastTurnChanges(agent, store);
  const only = await lastTurnPaths(agent, store);
  return only ? { ...result, files: result.files.filter((f) => only.has(f.path)) } : result;
}

// 이 세션이 만진 파일 목록(핸드오프 문서용). 지금 디스크가 기준과 다른 것만.
export async function sessionFiles(agent: Agent, store: Store): Promise<ChangedFile[]> {
  return (await touchedChanges(agent, store)).files;
}

// 되돌려도 되는 파일을 가른다. 장부에 있는 파일은 디스크가 에이전트의 마지막 쓰기와 같을 때만 허용한다.
// 장부에 없는 파일(Branch 나 Uncommitted 범위의 목록에서 사용자가 직접 고른 것)은 허용하되, Session 범위에서는 장부 밖 파일이 목록에 오르지 않는다.
export async function checkUndo(agent: Agent, store: Store, paths: string[]): Promise<UndoCheck> {
  const ledger = await ensureLedger(agent, store);
  const allowed: string[] = [];
  const skipped: UndoSkip[] = [];
  for (const path of paths) {
    const entry = ledger?.files[path];
    if (!entry) {
      allowed.push(path);
      continue;
    }
    if (entry.pending) {
      allowed.push(path);
      continue;
    }
    if (entry.mixed) skipped.push({ path, reason: "mixed" });
    else if (entry.after === undefined) skipped.push({ path, reason: "unknown" });
    else if (await modifiedSince(entry, path)) skipped.push({ path, reason: "modified" });
    else allowed.push(path);
  }
  return { allowed, skipped };
}

// --- FIX5-0: 체크포인트 복원 ---

// 심볼릭 링크 때문에 경로 표기가 달라질 수 있어(/tmp 와 /private/tmp) 폴더를 실제 경로로 바꾼 이름. SDK 가 돌려주는 경로와 훅이 받은 경로를 같은 이름으로 맞추는 데 쓴다.
export async function canonPath(path: string) {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute)).catch(() => dirname(absolute));
  return join(parent, basename(absolute));
}

async function ledgerKeys(ledger: Ledger) {
  const keys = new Map<string, string>();
  for (const key of Object.keys(ledger.files)) keys.set(await canonPath(key), key);
  return keys;
}

// 체크포인트 복원이 되돌려 줄 파일(changed: rewindFiles dryRun 의 filesChanged)을 파일마다 가른다.
// 장부의 파일은 Undo 와 같은 규칙이다: 디스크가 에이전트의 마지막 쓰기(after)와 같을 때만 되돌린다. 장부에 없는 파일은 Undo 와 달리 건너뛴다(사용자가 목록에서 고른 것이 아니라서).
// 에이전트가 그 체크포인트 뒤에 처음 만든 파일(before 가 null 이고 kept, 즉 체크포인트 앞 대화에 그 파일을 만진 편집 도구 호출이 없다)은 되돌리면 파일이 없어지므로 remove 다.
// 장부를 못 쓰는 세션(폴더 없음, 피드백)은 가를 근거가 없어 전부 revert 로 둔다(옛 동작).
export async function planRestore(agent: Agent, store: Store, changed: string[], kept: TimelineItem[]): Promise<RestorePlan> {
  const plan: RestorePlan = { revert: [], remove: [], skip: [] };
  const ledger = await ensureLedger(agent, store);
  const cwd = await realpath(agent.cwd).catch(() => agent.cwd);
  const relOf = (canon: string) => {
    const rel = relative(cwd, canon);
    return rel.startsWith("..") || isAbsolute(rel) ? canon : rel;
  };
  const keys = ledger ? await ledgerKeys(ledger) : new Map<string, string>();
  const root = await rootOf(agent.cwd);
  const keptEdited = new Set(await Promise.all(editedPaths(agent, kept, root).map(canonPath)));
  for (const path of changed) {
    const canon = await canonPath(path);
    const rel = relOf(canon);
    if (!ledger) {
      plan.revert.push({ path, rel });
      continue;
    }
    const key = keys.get(canon);
    const entry = key ? ledger.files[key] : undefined;
    if (!entry) plan.skip.push({ path, rel, reason: "unknown" });
    else if (!entry.pending && entry.mixed) plan.skip.push({ path, rel, reason: "mixed" });
    else if (!entry.pending && entry.after === undefined) plan.skip.push({ path, rel, reason: "unknown" });
    else if (await modifiedSince(entry, path)) plan.skip.push({ path, rel, reason: "modified" });
    else if (entry.before === null && !keptEdited.has(canon)) plan.remove.push({ path, rel });
    else plan.revert.push({ path, rel });
  }
  return plan;
}

// 복원이나 Redo 가 파일을 쓴 뒤 장부의 after 를 지금 디스크에 맞춘다. 맞추지 않으면 다음 편집이 "다른 손이 고쳤다" 로 오인되어 mixed 가 되고 Undo 와 복원이 이유 없이 거절된다.
// 항목은 지우지 않는다(before 가 있어야 Redo 로 에이전트의 변경이 되살아날 때 목록에 다시 오른다).
export async function syncAfterRestore(agent: Agent, store: Store, paths: string[]) {
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return;
  const keys = await ledgerKeys(ledger);
  for (const path of paths) {
    const key = keys.get(await canonPath(path));
    const entry = key ? ledger.files[key] : undefined;
    if (!entry) continue;
    const state = await readState(path);
    if (state) entry.after = state.hash;
    else delete entry.after;
    delete entry.pending;
  }
  save(agent.id);
}

// 되돌린 파일은 장부에서 뺀다. 다음에 에이전트가 만지면 그때 내용이 새 기준이 된다.
export async function forgetTouched(agent: Agent, store: Store, paths: string[]) {
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return;
  for (const path of paths) delete ledger.files[path];
  ledger.turnFiles = ledger.turnFiles.filter((p) => !paths.includes(p));
  for (const path of paths) turns.get(agent.id)?.files.delete(path);
  save(agent.id);
}

export async function forgetLedger(agentId: string) {
  ledgers.delete(agentId);
  turns.delete(agentId);
  intervals.delete(agentId);
  dirty.delete(agentId);
  const timer = timers.get(agentId);
  if (timer) clearTimeout(timer);
  timers.delete(agentId);
  await rm(join(DIR, `${agentId}.json`), { force: true });
}

// 디스크에는 짧은 지연 뒤 한 번에 쓴다(편집마다 장부 전체를 다시 쓰지 않게). 데몬이 끝날 때는 남은 것을 바로 쓴다.
function save(agentId: string) {
  dirty.add(agentId);
  if (timers.has(agentId)) return;
  const timer = setTimeout(() => {
    timers.delete(agentId);
    void flushOne(agentId);
  }, 400);
  timer.unref();
  timers.set(agentId, timer);
}

// 임시 파일에 쓴 뒤 rename 으로 바꾼다. 쓰는 도중 데몬이 죽거나 디스크가 차서 반쪽이 된 장부는 타임라인에서 다시 만들어지는데(load), 그러면 수정 전 내용과 after 해시를 잃어 Undo 와 복원이 전부 건너뛰어진다.
// 한 번에 동기로 써서 같은 세션의 쓰기 둘이 한 파일에 섞이지 않게 한다. 사용자 파일의 내용이 들어 있어 이 사용자만 읽게 만든다.
function writeLedger(agentId: string, ledger: Ledger) {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${agentId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  renameSync(tmp, file);
}

async function flushOne(agentId: string) {
  const ledger = ledgers.get(agentId);
  if (!ledger || !dirty.delete(agentId)) return;
  try {
    writeLedger(agentId, ledger);
  } catch (error) {
    console.error("[touched] save failed", error);
  }
}

export function flushTouchedSync() {
  for (const agentId of [...dirty]) {
    const ledger = ledgers.get(agentId);
    dirty.delete(agentId);
    if (!ledger) continue;
    try {
      writeLedger(agentId, ledger);
    } catch {
      // 종료 중 저장 실패는 다음 실행에서 타임라인으로 다시 만든다
    }
  }
}

process.once("exit", flushTouchedSync);

// 시험이 쓰는 초기화: 메모리 상태를 비운다(디스크는 그대로).
export function resetTouchedMemory() {
  ledgers.clear();
  loading.clear();
  turns.clear();
  intervals.clear();
  roots.clear();
}
