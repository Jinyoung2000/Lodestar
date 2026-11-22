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

const DIR = join(HOME, "touched");
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_BYTES = 2 * 1024 * 1024;
const ABSENT = "absent";
export const TOUCH_BASE = "touched";

export type Touch = {
  before: string | null;
  after?: string;
  pending?: true;
  mixed?: true;
  via: "edit" | "bash";
};

type Ledger = {
  files: Record<string, Touch>;
  turnFiles: string[];
  listsSession: boolean;
  migrated?: true;
  shellNotes?: { at: string; title: string }[];
};
const SHELL_NOTE_KEEP = 5;

type TurnState = { start: number; files: Set<string>; bash: boolean; ended: boolean };

const ledgers = new Map<string, Ledger>();
const loading = new Map<string, Promise<Ledger | null>>();
const turns = new Map<string, TurnState>();
const intervals = new Map<string, { start: number; end: number | null; cwd: string }[]>();
const INTERVAL_KEEP = 20;
const dirty = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

export const hashOf = (content: Buffer | null) => (content === null ? ABSENT : createHash("sha1").update(content).digest("hex"));

export const tracksTouches = (agent: Pick<Agent, "workspaceId" | "feedbackId">) => agent.workspaceId !== null && !agent.feedbackId;

const listsSessionOf = (agent: Pick<Agent, "worktree" | "forkBased" | "startCommit">) => agent.forkBased === true || (!agent.worktree && !!agent.startCommit);

export async function readState(path: string): Promise<{ text: string | null; hash: string } | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.length > MAX_BYTES || buffer.includes(0)) return undefined;
    return { text: buffer.toString("utf8"), hash: hashOf(buffer) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { text: null, hash: ABSENT } : undefined;
  }
}

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
    }
  }
  const ledger = await migrate(agent, store);
  ledgers.set(agent.id, ledger);
  save(agent.id);
  return ledger;
}

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
    if (!state) return false;
    ledger.files[absolute] = { before: state.text, after: state.hash, pending: true, via: "edit" };
  } else {
    if (!entry.pending && (!state || entry.after !== state.hash)) entry.mixed = true;
    entry.pending = true;
  }
  turnOf(agent.id).files.add(absolute);
  save(agent.id);
  return true;
}

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

export function beginTurn(agent: Pick<Agent, "id" | "cwd">) {
  const turn = turns.get(agent.id);
  if (!turn || turn.ended) {
    turns.set(agent.id, { start: Date.now(), files: new Set(), bash: false, ended: false });
    const list = intervals.get(agent.id) ?? [];
    list.push({ start: Date.now(), end: null, cwd: agent.cwd });
    intervals.set(agent.id, list.slice(-INTERVAL_KEEP));
  }
}

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

async function modifiedSince(entry: Touch, path: string) {
  if (entry.pending) return false;
  if (entry.mixed || entry.after === undefined) return true;
  const state = await readState(path);
  return !state || state.hash !== entry.after;
}

export async function touchedChanges(agent: Agent, store: Store): Promise<{ base: string | null; files: ChangedFile[]; shellNote?: ShellNote }> {
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return { base: null, files: [] };
  const files = await compareWith(agent, Object.keys(ledger.files), (path) => Promise.resolve(ledger.files[path].before));
  const flagged = await Promise.all(files.map(async (file): Promise<ChangedFile> => ((await modifiedSince(ledger.files[file.path], file.path)) ? { ...file, modifiedSince: true } : file)));
  return { base: TOUCH_BASE, files: flagged, ...(ledger.shellNotes?.length ? { shellNote: { turns: ledger.shellNotes } } : {}) };
}

export async function touchedOriginal(agent: Agent, store: Store, absolute: string): Promise<string | null | undefined> {
  const ledger = await ensureLedger(agent, store);
  const entry = ledger?.files[absolute];
  return entry ? entry.before : undefined;
}

export async function isTouched(agent: Agent, store: Store, absolute: string) {
  const ledger = await ensureLedger(agent, store);
  return !!ledger?.files[absolute];
}

export async function lastTurnPaths(agent: Agent, store: Store): Promise<Set<string> | null> {
  const ledger = await ensureLedger(agent, store);
  if (!ledger) return null;
  const live = turns.get(agent.id);
  return new Set(live ? live.files : ledger.turnFiles);
}

export async function touchedLastTurn(agent: Agent, store: Store): Promise<{ base: string | null; files: ChangedFile[] }> {
  const result = await lastTurnChanges(agent, store);
  const only = await lastTurnPaths(agent, store);
  return only ? { ...result, files: result.files.filter((f) => only.has(f.path)) } : result;
}

export async function sessionFiles(agent: Agent, store: Store): Promise<ChangedFile[]> {
  return (await touchedChanges(agent, store)).files;
}

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
    }
  }
}

process.once("exit", flushTouchedSync);

export function resetTouchedMemory() {
  ledgers.clear();
  loading.clear();
  turns.clear();
  intervals.clear();
  roots.clear();
}
