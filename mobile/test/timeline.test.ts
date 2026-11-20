import type { TimelineItem } from "../../shared/protocol";
import { mergeTail, prependOlder, remove, upsert } from "../src/logic/timeline";
import { expect, run, test } from "./harness";

const a = (id: string, text = id, streaming = false): TimelineItem => ({ id, kind: "assistant", text, streaming });
const ids = (items: readonly TimelineItem[]) => items.map((i) => i.id).join(",");
const page = (items: TimelineItem[], total: number, hasMore: boolean) => ({ items, total, hasMore });

test("mergeTail: 캐시와 겹치면 앞쪽 캐시는 두고 그 뒤는 서버 것으로 바꾼다", () => {
  const local = [a("1"), a("2"), a("3", "old")];
  const merged = mergeTail(local, true, page([a("3", "new"), a("4")], 9, true));
  expect(ids(merged.items) === "1,2,3,4", ids(merged.items));
  expect((merged.items[2] as { text: string }).text === "new", "server wins");
  expect(merged.hasMore === true, "older cache keeps the local flag");
  return ids(merged.items);
});

test("mergeTail: 조각이 캐시 첫 항목에서 시작하면 hasMore 는 서버 값", () => {
  const merged = mergeTail([a("5"), a("6")], true, page([a("5"), a("6"), a("7")], 3, false));
  expect(ids(merged.items) === "5,6,7" && merged.hasMore === false, `${ids(merged.items)} ${merged.hasMore}`);
  return "ok";
});

test("mergeTail: 겹치지 않으면(오래 떨어져 있었다) 조각으로 통째로 바꾼다", () => {
  const merged = mergeTail([a("1"), a("2")], false, page([a("50"), a("51")], 51, true));
  expect(ids(merged.items) === "50,51" && merged.hasMore === true, ids(merged.items));
  return "ok";
});

test("mergeTail: 서버가 빈 목록이면 비운다, 내용이 같은 항목은 같은 객체를 유지한다", () => {
  expect(mergeTail([a("1")], true, page([], 0, false)).items.length === 0, "empty");
  const local = [a("1"), a("2", "same")];
  const merged = mergeTail(local, false, page([a("1"), a("2", "same")], 2, false));
  expect(merged.items[0] === local[0] && merged.items[1] === local[1], "identity kept so rows do not re-render");
  const changed = mergeTail(local, false, page([a("1"), a("2", "different")], 2, false));
  expect(changed.items[0] === local[0] && changed.items[1] !== local[1], "only the changed row is replaced");
  return "ok";
});

test("upsert, remove: id 로 바꾸거나 끝에 붙이고, 없는 id 삭제는 같은 배열을 돌려준다", () => {
  const list = [a("1"), a("2")];
  expect(ids(upsert(list, a("2", "x"))) === "1,2" && (upsert(list, a("2", "x"))[1] as { text: string }).text === "x", "replace");
  expect(ids(upsert(list, a("3"))) === "1,2,3", "append");
  expect(remove(list, "zz") === list, "unchanged identity");
  expect(ids(remove(list, "1")) === "2", "removed");
  return "ok";
});

test("prependOlder: 이미 있는 id 는 건너뛴다", () => {
  const older = prependOlder([a("5"), a("6")], page([a("3"), a("4"), a("5")], 6, true));
  expect(ids(older.items) === "3,4,5,6" && older.hasMore === true, ids(older.items));
  return "ok";
});

void run();
