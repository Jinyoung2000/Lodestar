import { noteActive, ALL_GROUPS, type TabMru } from "../web/tabMru";
import { groupLabel, openingIndex, stepIndex, switcherRows, tabDescription, withoutRow } from "../web/tabSwitcherModel";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
};
const keys = (rows: { key: string }[]) => rows.map((r) => r.key).join(",");

const tabs = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "x", group: "g2" }, { key: "y", group: "g2" }];
let mru: TabMru = {};
let active: { group: string; key: string | null } = { group: "main", key: null };
for (const [group, key] of [["main", "a"], ["main", "b"], ["g2", "x"], ["main", "c"], ["g2", "y"]] as const) {
  mru = noteActive(mru, active, { group, key });
  active = { group, key };
}

check("the global list records activations across groups", keys((mru[ALL_GROUPS] ?? []).map((key) => ({ key }))) === "a,b,x,c,y", (mru[ALL_GROUPS] ?? []).join(","));
check("a group's own list is untouched by other groups", (mru.main ?? []).join(",") === "a,b,c" && (mru.g2 ?? []).join(",") === "x,y");

const groupOrder = ["main", "g2"];
const inGroup = switcherRows({ scope: "group", activeGroup: "g2", activeKey: "y", tabs, groupOrder, mru: mru.g2 ?? [] });
check("in-group scope lists only the active group, current editor first", keys(inGroup) === "y,x", keys(inGroup));
check("in-group scope still labels the group when there are several", inGroup[0].header && inGroup[0].groupName === "Group 2" && !inGroup[1].header);

const all = switcherRows({ scope: "all", activeGroup: "g2", activeKey: "y", tabs, groupOrder, mru: mru[ALL_GROUPS] ?? [] });
check("all-groups scope orders by recent use across groups", keys(all) === "y,c,x,b,a", keys(all));
check("headers repeat when the group changes between neighbours", all.map((r) => (r.header ? r.groupName : "-")).join(",") === "Group 2,Group 1,Group 2,Group 1,-", all.map((r) => (r.header ? r.groupName : "-")).join(","));

const single = switcherRows({ scope: "group", activeGroup: "main", activeKey: "c", tabs: tabs.filter((t) => !t.group), groupOrder: ["main"], mru: mru.main ?? [] });
check("one group: no header rows and no group names", keys(single) === "c,b,a" && single.every((r) => !r.header && r.groupName === null), keys(single));

const unseen = switcherRows({ scope: "all", activeGroup: "main", activeKey: "a", tabs: [...tabs, { key: "n1", group: "g2" }, { key: "n0" }], groupOrder, mru: [] });
check("tabs with no recorded use follow in group, then tab order", keys(unseen) === "a,b,c,n0,x,y,n1", keys(unseen));

const pseudo = switcherRows({ scope: "group", activeGroup: "main", activeKey: "changes", tabs: tabs.filter((t) => !t.group), groupOrder: ["main"], mru: ["a", "b", "c"] });
check("an active key that is not an editor (Changes) leaves the list in recent order", keys(pseudo) === "c,b,a", keys(pseudo));

check("opening picks the second row for forward, the last row for backward", openingIndex(5, "second") === 1 && openingIndex(5, "last") === 4);
check("a one-row list stays on that row", openingIndex(1, "second") === 0 && openingIndex(1, "last") === 0 && openingIndex(0, "second") === 0);
check("stepping wraps at both ends", stepIndex(4, 5, 1) === 0 && stepIndex(0, 5, -1) === 4 && stepIndex(2, 5, 1) === 3);

const closed = withoutRow(all, 1, "y");
check("closing a row before the selected one keeps the selected tab", keys(closed.rows) === "c,x,b,a" && closed.rows[closed.index].key === "c", `${keys(closed.rows)} @${closed.index}`);
check("closing the middle group row merges neighbours of the same group under one header", (() => {
  const rows = withoutRow(all, 0, "c").rows;
  return keys(rows) === "y,x,b,a" && rows.map((r) => (r.header ? r.groupName : "-")).join(",") === "Group 2,-,Group 1,-";
})(), "y,c,x,b,a minus c");
check("closing the last row leaves an empty list", withoutRow([{ key: "q", group: "main", groupName: null, header: false }], 0, "q").rows.length === 0);

check("description is the folder of the file, empty at the root", tabDescription("src/web/store.ts") === "src/web" && tabDescription("README.md") === "" && tabDescription(undefined) === "");
check("group names are 1-based", groupLabel(1) === "Group 1");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("tab switcher model: all passed");
