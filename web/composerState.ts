import type { TimelineItem } from "../shared/protocol";
import { windowStorage } from "./windowStorage";

const drafts = new Map<string, string>();
export const DRAFT_STORAGE_PREFIX = "agent-nav:draft:";
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
  }
}

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
  }
  return out;
}

export function dropStoredDraftsOfMissingPanes(paneIds: ReadonlySet<string>) {
  for (const key of Object.keys(loadStoredDrafts())) {
    if (!key.startsWith("new:") || paneIds.has(key.slice(4))) continue;
    drafts.delete(key);
    unsaved.delete(key);
    writeDraft(key);
  }
}

export const draftKey = (agentId: string | null, paneId: string) => (agentId ? agentId : `new:${paneId}`);

export function attachmentKey(panes: ReadonlyArray<{ id: string; kind: string; agentId?: string }>, paneId: string) {
  const pane = panes.find((p) => p.id === paneId);
  return draftKey(pane?.kind === "agent" ? (pane.agentId ?? null) : (virtualPanes.get(paneId) ?? null), paneId);
}

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

export function restoreDrafts(saved: Record<string, string>) {
  for (const [key, text] of Object.entries(saved)) {
    if (!text) continue;
    drafts.set(key, text);
    writeDraft(key);
  }
}

export function dropDraftsOfMissing(agentIds: ReadonlySet<string>) {
  for (const key of [...drafts.keys()]) {
    if (key.startsWith("new:") || agentIds.has(key)) continue;
    drafts.delete(key);
    unsaved.delete(key);
    writeDraft(key);
  }
}

export const HISTORY_LIMIT = 50;

export function historyOf(items: TimelineItem[] | undefined): string[] {
  const sent = (items ?? []).filter((i): i is Extract<TimelineItem, { kind: "user" }> => i.kind === "user" && i.source !== "system").map((i) => i.shown ?? i.text);
  return sent.slice(-HISTORY_LIMIT);
}

export function stepHistory(length: number, index: number | null, direction: "up" | "down"): number | null {
  if (length === 0) return null;
  if (direction === "up") return index === null ? length - 1 : Math.max(index - 1, 0);
  if (index === null) return null;
  return index + 1 >= length ? null : index + 1;
}

export type Trigger = { kind: "slash" | "mention"; query: string; start: number; end: number };

export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  if (before.startsWith("/") && !/\s/.test(before)) return { kind: "slash", query: before.slice(1), start: 0, end: caret };
  const slash = before.lastIndexOf("/");
  if (slash > 0 && /\s/.test(before[slash - 1]) && !/[\s/]/.test(before.slice(slash + 1)) && slash > before.lastIndexOf("@")) return { kind: "slash", query: before.slice(slash + 1), start: slash, end: caret };
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const token = before.slice(at + 1);
  if (/\s/.test(token)) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  return { kind: "mention", query: token, start: at, end: caret };
}

export function applyTrigger(text: string, trigger: Trigger, replacement: string): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + replacement + text.slice(trigger.end);
  return { text: next, caret: trigger.start + replacement.length };
}

export function applyMention(text: string, trigger: Trigger, path: string): { text: string; caret: number } {
  const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  const after = text.slice(trigger.end);
  const gap = after === "" || !/^\s/.test(after) ? " " : "";
  const caret = trigger.start + mention.length + (gap || after[0] !== "\n" ? 1 : 0);
  return { text: text.slice(0, trigger.start) + mention + gap + after, caret };
}

export function removeMention(text: string, trigger: Trigger): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const trimmed = /\s$/.test(before) && /^[ \t]/.test(after) ? after.slice(1) : after;
  return { text: before + trimmed, caret: before.length };
}

export function continueMarkdown(text: string, caret: number): { text: string; caret: number } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  const match = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))(\s+)(\[[ xX]\]\s+)?/.exec(line);
  if (!match) return null;
  const [marker, indent, bullet, num, delimiter, quote, gap, task] = match;
  if (line.length === marker.length) {
    return { text: text.slice(0, lineStart) + text.slice(caret), caret: lineStart };
  }
  const next = num ? `${Number(num) + 1}${delimiter}` : (bullet ?? quote);
  const insert = `\n${indent}${next}${gap}${task ? "[ ] " : ""}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}
