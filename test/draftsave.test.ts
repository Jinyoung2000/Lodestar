import { DRAFT_DEBOUNCE_MS, DRAFT_STORAGE_PREFIX, DRAFT_SYNC_LIMIT, dropDraftsOfMissing, dropStoredDraftsOfMissingPanes, flushDrafts, getDraft, loadStoredDrafts, restoreDrafts, setDraft, setDraftStorage } from "../web/composerState";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};

function fakeStorage(options: { throws?: boolean } = {}) {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (options.throws) throw new Error("quota");
      writes.push(k);
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

const K = (key: string) => DRAFT_STORAGE_PREFIX + key;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, () => void>();
let nextTimer = 1;
globalThis.setTimeout = ((fn: () => void) => {
  const id = nextTimer++;
  timers.set(id, fn);
  return id as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => void timers.delete(id)) as typeof clearTimeout;
const fireTimers = () => {
  for (const [id, fn] of [...timers]) {
    timers.delete(id);
    fn();
  }
};

{
  const s = fakeStorage();
  setDraftStorage(s);
  setDraft("agent-1", "h");
  check("stored in the same call as the keystroke", s.data.get(K("agent-1")) === "h");
  setDraft("agent-1", "he");
  check("each keystroke updates only that draft's key", s.data.get(K("agent-1")) === "he" && s.writes.length === 2);
  setDraft("agent-1", "he");
  check("same text again writes nothing", s.writes.length === 2);
  setDraft("new:pane-1", "other");
  check("drafts are separate keys", s.data.get(K("new:pane-1")) === "other" && s.data.get(K("agent-1")) === "he");
  setDraft("agent-1", "");
  check("emptying the draft removes its key", !s.data.has(K("agent-1")) && getDraft("agent-1") === "");
}

{
  const s = fakeStorage();
  setDraftStorage(s);
  const big = "x".repeat(DRAFT_SYNC_LIMIT + 1);
  setDraft("agent-big", big);
  check("a long draft waits for the short debounce", !s.data.has(K("agent-big")) && timers.size === 1, `debounce ${DRAFT_DEBOUNCE_MS}ms`);
  setDraft("agent-big", `${big}y`);
  setDraft("agent-big", `${big}yz`);
  check("keystrokes inside the window share one timer and write nothing yet", timers.size === 1 && s.writes.length === 0);
  flushDrafts();
  check("flush before leaving writes the latest text", s.data.get(K("agent-big")) === `${big}yz` && s.writes.length === 1 && timers.size === 0);
  setDraft("agent-big", `${big}yzw`);
  fireTimers();
  check("the timer writes it too", s.data.get(K("agent-big")) === `${big}yzw`);
  setDraft("agent-big", "");
  check("a draft that shrank below the limit is written at once", !s.data.has(K("agent-big")));
}

{
  setDraftStorage(fakeStorage({ throws: true }));
  let threw = false;
  try {
    setDraft("agent-2", "still typing");
  } catch {
    threw = true;
  }
  check("a full or blocked storage never throws into typing", !threw && getDraft("agent-2") === "still typing");
  setDraftStorage(null);
  setDraft("agent-2", "no storage at all");
  check("no storage (embedded window) keeps the draft in memory only", getDraft("agent-2") === "no storage at all");
}

{
  const s = fakeStorage();
  s.data.set(K("agent-a"), "from storage");
  s.data.set("agent-nav:window-state", "{}");
  s.data.set(K("empty"), "");
  setDraftStorage(s);
  const stored = loadStoredDrafts();
  check("lists only draft keys with text", JSON.stringify(stored) === JSON.stringify({ "agent-a": "from storage" }), JSON.stringify(stored));
  restoreDrafts({ "agent-old": "from the old window state" });
  check("a draft from the old window state moves into storage", s.data.get(K("agent-old")) === "from the old window state" && getDraft("agent-old") === "from the old window state");
  restoreDrafts(stored);
  check("restored drafts are readable", getDraft("agent-a") === "from storage");
}

{
  const s = fakeStorage();
  setDraftStorage(s);
  setDraft("alive", "keep");
  setDraft("gone", "drop");
  setDraft("new:pane-1", "pane draft");
  setDraft("new:pane-9", "orphan");
  dropDraftsOfMissing(new Set(["alive"]));
  check("a deleted session's draft is removed from memory and storage", getDraft("gone") === "" && !s.data.has(K("gone")) && s.data.has(K("alive")));
  check("a new-session pane draft is not touched by session cleanup", getDraft("new:pane-9") === "orphan");
  dropStoredDraftsOfMissingPanes(new Set(["pane-1"]));
  check("an orphan pane draft is removed, an existing pane's stays", !s.data.has(K("new:pane-9")) && getDraft("new:pane-9") === "" && getDraft("new:pane-1") === "pane draft" && s.data.has(K("new:pane-1")));
}

setDraftStorage(undefined);
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
