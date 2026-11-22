import { dropTabFocus, isShown, ownerOf, pruneTabFocus, sanitizeTabFocus, settleSessionTabs, shownAgentsOf, shownTabs, type SessionTab, type SettleInput, type TabFocus } from "../web/sessionTabs";
import { pruneTabState, type TabLike } from "../web/windowState";
import type { Pane } from "../web/store";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};
const same = (actual: unknown, wanted: unknown, label: string) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(wanted);
  if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
};

const agentPane = (id: string, agentId: string): Pane => ({ id, kind: "agent", agentId }) as Pane;
const draftPane = (id: string): Pane => ({ id, kind: "draft", workspaceId: "w" }) as Pane;
const pr = (key: string, agentId?: string, group?: string): SessionTab => ({ key, kind: "pr", ...(agentId ? { agentId } : {}), ...(group ? { group } : {}) });
const file = (key: string, group?: string): SessionTab => ({ key, kind: "file", ...(group ? { group } : {}) });
const set = (...ids: string[]) => new Set(ids);

const run = (input: Partial<SettleInput> & Pick<SettleInput, "tabs" | "prevAgents" | "agents" | "prevActive" | "active">) =>
  settleSessionTabs({ groups: ["main", "g1"], focus: {}, restore: true, pick: (_g, _hidden, shown) => shown.at(-1) ?? null, ...input });

test("only PR tabs with an agentId belong to a session", () => {
  expect(ownerOf(pr("pr:a#1", "A")) === "A", "PR with agent");
  expect(ownerOf(pr("pr:a#1")) === null, "PR without agent");
  expect(ownerOf({ key: "d", kind: "diff", agentId: "A" }) === null, "diff agentId is only a data source");
  expect(ownerOf(file("f")) === null, "file");
  return "pr only";
});

test("shown: unowned tabs always, owned tabs only while the session has a pane", () => {
  const agents = set("A");
  expect(isShown(pr("p", "A"), agents), "A shown");
  expect(!isShown(pr("p", "B"), agents), "B hidden");
  expect(isShown(pr("p"), agents) && isShown(file("f"), agents), "unowned shown");
  expect(isShown(pr("p", "B")), "no agents given: no filtering");
  return "A shown, B hidden";
});

test("shownAgentsOf lists agent panes, ignores drafts, and keeps identity while the set is unchanged", () => {
  const panes = [agentPane("p1", "A"), draftPane("p2"), agentPane("p3", "B")];
  const a = shownAgentsOf({ panes });
  same([...a], ["A", "B"], "agents");
  const moved = [agentPane("q1", "A"), agentPane("q3", "B")];
  expect(shownAgentsOf({ panes: moved }) === a, "same ids, same set (selectors do not rerender)");
  const next = shownAgentsOf({ panes: [agentPane("p1", "A")] });
  expect(next !== a && next.size === 1, "different set");
  return "A,B then A";
});

test("shownTabs returns the same array when nothing is hidden, and the same result for the same input", () => {
  const tabs = [file("f"), pr("p1", "A"), pr("p2", "B")];
  const a = set("A");
  const out = shownTabs(tabs, a);
  same(out.map((t) => t.key), ["f", "p1"], "filtered");
  expect(shownTabs(tabs, a) === out, "memoized");
  const all = [file("f"), pr("p1", "A")];
  expect(shownTabs(all, a) === all, "nothing hidden returns input");
  return "f,p1";
});

test("session switch A to B: the active PR tab of A falls back to a tab B can see, and A remembers it", () => {
  const tabs = [file("f1"), pr("pA", "A"), file("f2")];
  const out = run({ tabs, prevAgents: set("A"), agents: set("B"), prevActive: { main: "pA", g1: null }, active: { main: "pA", g1: null } });
  expect(out.active.main === "f2", `fell back to ${out.active.main}`);
  same(out.focus, { A: { main: "pA" } }, "remembered");
  return "pA -> f2, A remembers pA";
});

test("session switch back B to A: the remembered PR tab becomes active again", () => {
  const tabs = [file("f1"), pr("pA", "A"), file("f2")];
  const focus: TabFocus = { A: { main: "pA" } };
  const out = run({ tabs, focus, prevAgents: set("B"), agents: set("A"), prevActive: { main: "f2", g1: null }, active: { main: "f2", g1: null } });
  expect(out.active.main === "pA", `restored ${out.active.main}`);
  same(out.focus, focus, "memory stays (cleared only when A leaves on another tab)");
  return "f2 -> pA";
});

test("an update that picks the active tab itself is not overwritten by the returning session", () => {
  const tabs = [file("f1"), pr("pA", "A")];
  const out = run({ tabs, focus: { A: { main: "pA" } }, restore: false, prevAgents: set("B"), agents: set("A"), prevActive: { main: "f1" }, active: { main: "f1" } });
  expect(out.active.main === "f1", out.active.main ?? "null");
  return "kept f1";
});

test("leaving A while a plain tab is active clears A's memory for that group", () => {
  const tabs = [file("f1"), pr("pA", "A")];
  const out = run({ tabs, focus: { A: { main: "pA" } }, prevAgents: set("A"), agents: set("B"), prevActive: { main: "f1", g1: null }, active: { main: "f1", g1: null } });
  same(out.focus, {}, "memory cleared");
  expect(out.active.main === "f1", "active stays");
  return "memory cleared";
});

test("a split group with only A's PR tab has no visible tab while A is away (null), and gets it back", () => {
  const tabs = [file("f1"), pr("pA", "A", "g1")];
  const away = run({ tabs, pick: () => null, prevAgents: set("A"), agents: set("B"), prevActive: { main: "f1", g1: "pA" }, active: { main: "f1", g1: "pA" } });
  expect(away.active.g1 === null, "g1 empty");
  same(away.focus, { A: { g1: "pA" } }, "g1 remembered");
  const back = run({ tabs, focus: away.focus, prevAgents: set("B"), agents: set("A"), prevActive: { main: "f1", g1: null }, active: { main: "f1", g1: null } });
  expect(back.active.g1 === "pA", "g1 restored");
  return "g1 null then pA";
});

test("the pick fallback sees only the group's visible keys", () => {
  const seen: string[][] = [];
  const tabs = [pr("pA", "A"), file("f1"), pr("pB", "B"), file("f2", "g1")];
  run({ tabs, pick: (_g, _h, shown) => (seen.push([...shown]), null), prevAgents: set("A"), agents: set("B"), prevActive: { main: "pA" }, active: { main: "pA" } });
  same(seen, [["f1", "pB"]], "shown keys of main");
  return "f1,pB";
});

test("a hidden remembered tab in the active slot is moved even without a session change (restored window)", () => {
  const tabs = [file("f1"), pr("pB", "B")];
  const out = run({ tabs, prevAgents: set("A"), agents: set("A"), prevActive: { main: "pB" }, active: { main: "pB" } });
  expect(out.active.main === "f1", out.active.main ?? "null");
  return "pB -> f1";
});

test("nothing to change returns the same active record", () => {
  const tabs = [file("f1"), pr("pA", "A")];
  const active = { main: "pA", g1: null };
  const out = run({ tabs, prevAgents: set("A"), agents: set("A"), prevActive: active, active });
  expect(out.active === active, "same ref");
  return "same ref";
});

test("two sessions on screen at once: both PR tabs are visible, leaving one hides only its tab", () => {
  const tabs = [pr("pA", "A"), pr("pB", "B")];
  const both = run({ tabs, prevAgents: set("A", "B"), agents: set("A", "B"), prevActive: { main: "pB" }, active: { main: "pB" } });
  expect(both.active.main === "pB", "stays");
  const onlyA = run({ tabs, prevAgents: set("A", "B"), agents: set("A"), prevActive: { main: "pB" }, active: { main: "pB" } });
  expect(onlyA.active.main === "pA", onlyA.active.main ?? "null");
  same(onlyA.focus, { B: { main: "pB" } }, "B remembered");
  return "pB -> pA";
});

test("memory of a deleted session is pruned, and dropTabFocus removes one session", () => {
  const focus: TabFocus = { A: { main: "p1" }, B: { main: "p2" } };
  same(pruneTabFocus(focus, set("A")), { A: { main: "p1" } }, "prune");
  expect(pruneTabFocus(focus, set("A", "B")) === focus, "no change keeps ref");
  same(dropTabFocus(focus, "B"), { A: { main: "p1" } }, "drop");
  expect(dropTabFocus(focus, "Z") === focus, "unknown keeps ref");
  return "prune, drop";
});

test("sanitizeTabFocus keeps well-formed entries only", () => {
  same(sanitizeTabFocus({ A: { main: "p", g1: 3 }, B: "x", C: { main: "q" }, D: [] }), { A: { main: "p" }, C: { main: "q" } }, "clean");
  same(sanitizeTabFocus(null), {}, "null");
  same(sanitizeTabFocus([1]), {}, "array");
  return "clean";
});

test("restoring a window drops PR tabs of deleted sessions, keeps unowned ones and those of live sessions", () => {
  const tabs: TabLike[] = [
    { key: "f", kind: "file", workspaceId: "w1" },
    { key: "pr:a#1@A", kind: "pr", agentId: "A" },
    { key: "pr:a#2@gone", kind: "pr", agentId: "gone" },
    { key: "pr:a#3", kind: "pr" },
  ];
  const out = pruneTabState({ tabs, filesIndex: 0, activeTabKey: "pr:a#2@gone", groupActive: {}, mainEditorKey: null, activeWorkspaceId: null }, { workspaceIds: set("w1"), agentIds: set("A"), missingFileKeys: new Set() });
  same(out.tabs.map((t) => t.key), ["f", "pr:a#1@A", "pr:a#3"], "kept");
  expect(out.activeTabKey === "changes", "active falls to changes");
  return "gone dropped";
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
