import { FOLDERS_SCOPE, moveInOrder, stepInOrder } from "../shared/sessionOrder";
import { announce } from "./announce";
import { rpc } from "./rpc";
import type { ScopeList } from "./sessionList";
import { setSessionView } from "./sessionListState";
import { flash, getState, setState } from "./store";
import { S } from "./strings";

let lists: Record<string, ScopeList> = {};

export function publishSessionLists(next: Record<string, ScopeList>) {
  lists = next;
}

export function sessionListOf(scope: string): ScopeList | undefined {
  return lists[scope];
}

export function moveSession(scope: string, moving: string, target: string, edge: "before" | "after"): boolean {
  const list = lists[scope];
  const next = list && moveInOrder(list.ids, moving, target, edge);
  if (!list || !next) return false;
  save(scope, next, list.shown);
  return true;
}

export function stepSession(scope: string, moving: string, delta: -1 | 1, title: string): boolean {
  const list = lists[scope];
  const next = list && stepInOrder(list.ids, moving, delta, list.shown);
  if (!list || !next) return false;
  save(scope, next, list.shown);
  announce(S.sessionMovedTo(title, next.indexOf(moving) + 1, list.shown));
  return true;
}

export function moveFolder(moving: string, target: string, edge: "before" | "after"): boolean {
  if (!moveSession(FOLDERS_SCOPE, moving, target, edge)) return false;
  setSessionView({ folderOrder: "manual" });
  return true;
}

export function stepFolder(moving: string, delta: -1 | 1, name: string): boolean {
  if (!stepSession(FOLDERS_SCOPE, moving, delta, name)) return false;
  setSessionView({ folderOrder: "manual" });
  return true;
}

export function resetFolderOrder() {
  resetSessionOrder([FOLDERS_SCOPE]);
  setSessionView({ folderOrder: "recent" });
}

export function resetSessionOrder(scopes: string[]) {
  const previous = getState().sessionOrders;
  const next = { ...previous };
  for (const scope of scopes) delete next[scope];
  setState({ sessionOrders: next });
  rpc.call("sessionOrder.reset", { scopes }).catch((error: Error) => {
    setState({ sessionOrders: previous });
    flash(S.sessionOrderFailed(error.message), "error");
  });
}

function save(scope: string, ids: string[], shown: number) {
  const previous = getState().sessionOrders;
  lists = { ...lists, [scope]: { ids, shown } };
  setState({ sessionOrders: { ...previous, [scope]: ids } });
  rpc.call("sessionOrder.set", { scope, ids }).catch((error: Error) => {
    setState({ sessionOrders: previous });
    flash(S.sessionOrderFailed(error.message), "error");
  });
}
