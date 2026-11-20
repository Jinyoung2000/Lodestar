import { FOLDERS_SCOPE, moveInOrder, stepInOrder } from "../shared/sessionOrder";
import { announce } from "./announce";
import { rpc } from "./rpc";
import type { ScopeList } from "./sessionList";
import { setSessionView } from "./sessionListState";
import { flash, getState, setState } from "./store";
import { S } from "./strings";

// SESSIONORDER: 사이드바 세션 순서 바꾸기. 끌기(web/sessionDrag.ts)와 키보드(⌥↑, ⌥↓)가 같은 함수로 새 순서를 만들고, 낙관적으로 반영한 뒤 데몬(sessionOrder.set)에 저장한다.
// 데몬이 sessionOrders 이벤트로 다른 창에도 같은 순서를 보낸다. 순서 계산은 shared/sessionOrder.ts 의 순수 함수다.

// 사이드바가 마지막으로 그린 순서 목록(scope 별). 접힌 묶음, 접힌 부모, Show more 에 가려진 항목까지 담은 전체 순서라서, 새 순서를 저장할 때 보이지 않는 항목이 맨 위로 튀지 않는다.
let lists: Record<string, ScopeList> = {};

export function publishSessionLists(next: Record<string, ScopeList>) {
  lists = next;
}

export function sessionListOf(scope: string): ScopeList | undefined {
  return lists[scope];
}

// 끌기가 놓일 때: moving 을 target 의 앞이나 뒤로. 바뀌는 것이 없으면 false.
export function moveSession(scope: string, moving: string, target: string, edge: "before" | "after"): boolean {
  const list = lists[scope];
  const next = list && moveInOrder(list.ids, moving, target, edge);
  if (!list || !next) return false;
  save(scope, next, list.shown);
  return true;
}

// ⌥↑, ⌥↓: 화면에 보이는 이웃과 자리를 바꾼다. 맨 위나 보이는 맨 끝이면 false.
export function stepSession(scope: string, moving: string, delta: -1 | 1, title: string): boolean {
  const list = lists[scope];
  const next = list && stepInOrder(list.ids, moving, delta, list.shown);
  if (!list || !next) return false;
  save(scope, next, list.shown);
  announce(S.sessionMovedTo(title, next.indexOf(moving) + 1, list.shown));
  return true;
}

// 폴더 묶음 머리를 끌어 놓을 때: FOLDERS_SCOPE 의 순서를 바꾸고 Folder Order 를 Manual 로 돌린다.
export function moveFolder(moving: string, target: string, edge: "before" | "after"): boolean {
  if (!moveSession(FOLDERS_SCOPE, moving, target, edge)) return false;
  setSessionView({ folderOrder: "manual" });
  return true;
}

// 폴더 머리의 ⌥↑, ⌥↓. 세션과 같이 한 칸 옮기고 Manual 로 돌린다.
export function stepFolder(moving: string, delta: -1 | 1, name: string): boolean {
  if (!stepSession(FOLDERS_SCOPE, moving, delta, name)) return false;
  setSessionView({ folderOrder: "manual" });
  return true;
}

// 폴더 순서를 지우고 Recent Activity 로 돌아간다.
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
  // 화면이 다시 그려지기 전에 한 번 더 눌러도 방금 바뀐 순서에서 이어지게 한다
  lists = { ...lists, [scope]: { ids, shown } };
  setState({ sessionOrders: { ...previous, [scope]: ids } });
  rpc.call("sessionOrder.set", { scope, ids }).catch((error: Error) => {
    setState({ sessionOrders: previous });
    flash(S.sessionOrderFailed(error.message), "error");
  });
}
