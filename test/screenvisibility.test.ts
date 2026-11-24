import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-nav-screenvisibility-"));
process.env.AGENT_NAV_HOME = join(home, "nav");
mkdirSync(process.env.AGENT_NAV_HOME, { recursive: true });
const memory = new Map<string, string>();
const fake = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = fake;
g.sessionStorage = fake;
g.window = g;
g.addEventListener = () => {};
g.removeEventListener = () => {};
g.document = { querySelector: () => null, documentElement: { dataset: {}, style: {} }, addEventListener() {}, hasFocus: () => true, visibilityState: "visible" };
g.location = { reload() {}, origin: "http://localhost" };

const { boardShown, centerViewHidden, hiddenCommands, slackShown, visibleCenterView } = await import("../web/screenVisibility");
const { BINDINGS, stepKey } = await import("../web/keymap");
const { paletteCommands } = await import("../web/commands");
const { shortcutRows } = await import("../web/shortcutList");
const { searchGroups, visibleTabs } = await import("../web/searchModel");
const { getState, openCard, openInboxItem, setState, toggleBoard, toggleInbox } = await import("../web/store");
const { morningReviewCommand, receiveReview } = await import("../web/reviewActions");
const { currentNotices } = await import("../web/notices");
const { Store } = await import("../server/store");
const { mentionCollectionBlocked, morningReviewAutoBlocked } = await import("../server/mentionGate");
type Settings = import("../shared/protocol").Settings;
type SearchData = import("../web/searchModel").SearchData;

const cases: { name: string; run: () => string | Promise<string> }[] = [];
const test = (name: string, run: () => string | Promise<string>) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

const BOTH_ON = { showBoard: true, showSlack: true };
const settingsWith = (patch: Partial<Settings>) => ({ ...new Store().settings, ...patch }) as Settings;

test("both screens are hidden by default, unread settings included", () => {
  for (const settings of [null, undefined, {}, { showBoard: false, showSlack: false }]) {
    expect(!boardShown(settings) && !slackShown(settings), `shown for ${JSON.stringify(settings)}`);
    expect(centerViewHidden("board", settings) && centerViewHidden("inbox", settings), `views for ${JSON.stringify(settings)}`);
  }
  return "null, undefined, {} and false";
});

test("other screens are never hidden and a hidden screen becomes sessions", () => {
  for (const view of ["sessions", "pr", "improvements", "notion", "skills"] as const) expect(!centerViewHidden(view, null), view);
  expect(visibleCenterView("board", null) === "sessions" && visibleCenterView("inbox", {}) === "sessions", "hidden to sessions");
  expect(visibleCenterView("board", BOTH_ON) === "board" && visibleCenterView("inbox", BOTH_ON) === "inbox", "shown stays");
  return expect(visibleCenterView("board", { showBoard: true }) === "board" && visibleCenterView("inbox", { showBoard: true }) === "sessions", "independent flags");
});

test("hidden command names follow the two flags", () => {
  const none = hiddenCommands(null);
  expect(none.has("board") && none.has("morningReview") && none.has("inbox"), [...none].join(","));
  expect(hiddenCommands({ ...BOTH_ON, assistantEnabled: true }).size === 0, "both on");
  const boardOnly = hiddenCommands({ showBoard: true });
  return expect(!boardOnly.has("board") && !boardOnly.has("morningReview") && boardOnly.has("inbox"), [...boardOnly].join(","));
});

test("a new daemon home starts with both screens off, and only booleans are accepted", () => {
  const store = new Store();
  expect(store.settings.showSlack === false && store.settings.showBoard === false, `${store.settings.showSlack}, ${store.settings.showBoard}`);
  expect(store.updateSettings({ showSlack: "yes" as never }).showSlack === false, "string ignored");
  expect(store.updateSettings({ showBoard: 1 as never }).showBoard === false, "number ignored");
  const on = store.updateSettings({ showSlack: true, showBoard: true });
  expect(on.showSlack === true && on.showBoard === true, "turned on");
  const off = store.updateSettings({ showSlack: false });
  return expect(off.showSlack === false && off.showBoard === true, "turned one off");
});

test("a settings file without the keys (older install) reads as hidden", () => {
  const settings = { ...new Store().settings } as Partial<Settings>;
  delete settings.showSlack;
  delete settings.showBoard;
  return expect(!boardShown(settings) && !slackShown(settings), "missing keys");
});

test("Slack collection is blocked while Show Slack is off, and a test instance stays blocked when it is on", () => {
  expect(mentionCollectionBlocked({}, { showSlack: false }), "off");
  expect(mentionCollectionBlocked({}, {}), "missing key");
  expect(!mentionCollectionBlocked({}, { showSlack: true }), "on");
  expect(mentionCollectionBlocked({ AGENT_NAV_INACTIVE: "1" }, { showSlack: true }), "on but test instance");
  expect(!mentionCollectionBlocked({}), "no settings given (old callers)");
  const store = new Store();
  expect(mentionCollectionBlocked({}, store.settings), "fresh store settings");
  store.updateSettings({ showSlack: true });
  return expect(!mentionCollectionBlocked({}, store.settings), "after turning on");
});

test("the morning review does not run by itself while Show Board is off", () => {
  expect(morningReviewAutoBlocked({}, { showBoard: false }), "off");
  expect(!morningReviewAutoBlocked({}, { showBoard: true }), "on");
  expect(morningReviewAutoBlocked({ AGENT_NAV_INACTIVE: "1" }, { showBoard: true }), "test instance");
  expect(!morningReviewAutoBlocked({ AGENT_NAV_INACTIVE: "1", AGENT_NAV_REVIEW_AUTO: "1" }, { showBoard: true }), "test instance with REVIEW_AUTO");
  return expect(morningReviewAutoBlocked({ AGENT_NAV_REVIEW_AUTO: "1" }, { showBoard: false }), "REVIEW_AUTO does not override off");
});

const stroke = (code: string, mods: { meta?: boolean; shift?: boolean }) => [mods.shift ? "Shift" : "", mods.meta ? "Meta" : "", code].filter(Boolean).join("+");

test("shift+cmd+K and shift+cmd+L pass through while hidden and run when shown", () => {
  const ctx = { inTerminal: false, inEditor: false };
  const hidden = { ...ctx, hiddenCommands: hiddenCommands(null) };
  expect(stepKey(null, stroke("KeyK", { meta: true, shift: true }), hidden, 0).kind === "pass", "K hidden");
  expect(stepKey(null, stroke("KeyL", { meta: true, shift: true }), hidden, 0).kind === "pass", "L hidden");
  const shown = { ...ctx, hiddenCommands: hiddenCommands(BOTH_ON) };
  const k = stepKey(null, stroke("KeyK", { meta: true, shift: true }), shown, 0);
  const l = stepKey(null, stroke("KeyL", { meta: true, shift: true }), shown, 0);
  expect(k.kind === "run" && k.command === "board" && l.kind === "run" && l.command === "inbox", `${JSON.stringify(k)} ${JSON.stringify(l)}`);
  const noHint = stepKey(null, stroke("KeyK", { meta: true, shift: true }), ctx, 0);
  return expect(noHint.kind === "run", "a context without hiddenCommands keeps every binding");
});

test("the editor still gets shift+cmd+L (select highlights) while Slack is hidden", () => {
  const ctx = { inTerminal: false, inEditor: true, hiddenCommands: hiddenCommands(null) };
  const step = stepKey(null, "Shift+Meta+KeyL", ctx, 0);
  return expect(step.kind === "run" && step.command === "editor:selectHighlights", JSON.stringify(step));
});

test("the command palette and the shortcut list drop Board, Slack and Morning Review while hidden", () => {
  const names = ["board", "inbox", "morningReview"];
  const hidden = hiddenCommands(null);
  const palette = paletteCommands(undefined, { hidden }).map((c) => c.command);
  const rows = shortcutRows(undefined, { hidden }).map((r) => r.command);
  for (const name of names) expect(!palette.includes(name) && !rows.includes(name), `still listed: ${name}`);
  const all = paletteCommands(undefined, {}).map((c) => c.command);
  const allRows = shortcutRows(undefined, {}).map((r) => r.command);
  for (const name of names) expect(all.includes(name), `palette lost ${name} when nothing is hidden`);
  expect(allRows.includes("board") && allRows.includes("inbox"), "list lost board or inbox when nothing is hidden");
  const boardOnly = paletteCommands(undefined, { hidden: hiddenCommands({ showBoard: true }) }).map((c) => c.command);
  return expect(boardOnly.includes("board") && boardOnly.includes("morningReview") && !boardOnly.includes("inbox"), "flags are independent");
});

const baseData: SearchData = {
  agents: [],
  workspaces: [],
  recentAgentIds: [],
  fileWorkspaceId: null,
  files: [],
  recentFiles: [],
  prs: [],
  cards: [],
  columns: [],
  mentions: [],
  stamps: {},
  now: 0,
};

test("global search drops the Board and Mentions actions and tabs while hidden", () => {
  const titles = (data: SearchData, query: string) => searchGroups(data, "all", query).flatMap((group) => group.rows.filter((row) => row.kind === "action").map((row) => row.key));
  expect(titles(baseData, "").includes("action:board") && titles(baseData, "").includes("action:mentions"), "default actions when shown");
  const hidden = { ...baseData, hiddenActions: ["board", "mentions"] };
  expect(!titles(hidden, "").includes("action:board") && !titles(hidden, "").includes("action:mentions"), "default actions when hidden");
  expect(!titles(hidden, "board").includes("action:board") && !titles(hidden, "slack").includes("action:mentions"), "typed query when hidden");
  expect(titles(hidden, "automations").includes("action:automations"), "other actions stay");
  return expect(!visibleTabs(hidden).includes("board") && !visibleTabs(hidden).includes("mentions"), "tabs");
});

test("a saved window on the Board or Slack goes back to sessions once settings load, and stays when shown", () => {
  setState({ settings: null, centerView: "board" });
  expect(getState().centerView === "board", "kept until settings are known");
  setState({ settings: settingsWith({ showBoard: false }) });
  expect(getState().centerView === "sessions", "hidden board restored as sessions");
  setState({ settings: null, centerView: "inbox" });
  setState({ settings: settingsWith({ showSlack: false }) });
  expect(getState().centerView === "sessions", "hidden inbox restored as sessions");
  setState({ settings: null, centerView: "board" });
  setState({ settings: settingsWith({ showBoard: true }) });
  expect(getState().centerView === "board", "shown board kept");
  setState({ settings: settingsWith({ showBoard: false }) });
  return expect(getState().centerView === "sessions", "turning Show Board off while on the Board leaves it");
});

test("toggles and openers do nothing while hidden and work when shown", () => {
  setState({ settings: settingsWith({ showBoard: false, showSlack: false }), centerView: "sessions" });
  toggleBoard();
  expect(getState().centerView === "sessions", "toggleBoard hidden");
  toggleInbox();
  expect(getState().centerView === "sessions", "toggleInbox hidden");
  openInboxItem("C1:1.000000");
  expect(getState().centerView === "sessions" && getState().selectedInboxId === null, "openInboxItem hidden");
  setState({ settings: settingsWith({ showBoard: true, showSlack: true }) });
  toggleBoard();
  expect(getState().centerView === "board", "toggleBoard shown");
  toggleBoard();
  toggleInbox();
  return expect(getState().centerView === "inbox", "toggleInbox shown");
});

test("opening a card from a non-session screen uses the right panel Card tab while Board is hidden", () => {
  setState({ settings: settingsWith({ showBoard: false }), centerView: "pr", rightOpen: false, selectedCardId: null, boardCardId: null });
  openCard("card-1");
  const hidden = getState();
  expect(hidden.centerView === "sessions" && hidden.selectedCardId === "card-1" && hidden.activeTabKey === "card" && hidden.rightOpen && hidden.boardCardId === null, JSON.stringify({ v: hidden.centerView, c: hidden.selectedCardId, t: hidden.activeTabKey }));
  setState({ settings: settingsWith({ showBoard: true }), centerView: "pr", selectedCardId: null });
  openCard("card-2");
  const shown = getState();
  return expect(shown.centerView === "board" && shown.boardCardId === "card-2", `${shown.centerView} ${shown.boardCardId}`);
});

test("the card chip path (opening a card from the sessions screen) is the same whether Board is shown or hidden", () => {
  for (const showBoard of [false, true]) {
    setState({ settings: settingsWith({ showBoard }), centerView: "sessions", rightOpen: false, selectedCardId: null, activeTabKey: "changes" });
    openCard("card-3");
    const s = getState();
    expect(s.centerView === "sessions" && s.selectedCardId === "card-3" && s.activeTabKey === "card" && s.rightOpen, `showBoard ${showBoard}`);
  }
  return "sessions screen opens the Card tab";
});

test("the morning review command and its new-review toast do nothing while Board is hidden", () => {
  setState({ settings: settingsWith({ showBoard: false }), centerView: "sessions", review: null });
  morningReviewCommand();
  expect(getState().centerView === "sessions", "command");
  const reviewState = (unreadDate: string | null) => ({ reviews: [], running: false, error: null, unreadDate, lastRunAt: null }) as never;
  const reviewToasts = () => currentNotices().filter((n) => n.key === "morning-review").length;
  setState({ review: reviewState(null) });
  receiveReview(reviewState("2026-10-27"));
  expect(reviewToasts() === 0 && getState().centerView === "sessions", "toast while hidden");
  setState({ settings: settingsWith({ showBoard: true }), review: reviewState(null) });
  receiveReview(reviewState("2026-10-28"));
  return expect(reviewToasts() === 1, `toasts while shown: ${reviewToasts()}`);
});

test("the bindings table still has the two commands (the table is the source for the palette)", () => {
  return expect(BINDINGS.some((b) => b.command === "board") && BINDINGS.some((b) => b.command === "inbox"), "bindings");
});

let failed = 0;
for (const c of cases) {
  try {
    console.log(`ok   ${c.name} (${await c.run()})`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${(error as Error).message}`);
  }
}
rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : `${cases.length} passed`);
process.exit(failed ? 1 : 0);
