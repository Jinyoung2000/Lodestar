// 변경 패널 `...` 메뉴의 상태(web/changesState.ts)와 Diff View 의 Automatic(web/diffMode.ts).
// 실행: npm test
import { DIFF_VIEWS } from "../shared/protocol";
import { getChangesView, setAllDiffsCollapsed, setChangesWide, setTreeView, setWordWrap } from "../web/changesState";
import { chooseDiffMode, SPLIT_GAP, SPLIT_MIN_PANE } from "../web/diffWidth";

const cases: { name: string; run: () => string }[] = [];
const test = (name: string, run: () => string) => cases.push({ name, run });
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new Error(detail);
  return detail;
};

test("Diff View: Automatic 은 두 칸이 들어갈 때만 split", () => {
  expect((DIFF_VIEWS as readonly string[]).join() === "inline,split,auto", DIFF_VIEWS.join());
  const fit = SPLIT_MIN_PANE * 2 + SPLIT_GAP;
  expect(chooseDiffMode("auto", fit, true).mode === "split" && chooseDiffMode("auto", fit - 1, true).mode === "inline", "auto 경계");
  expect(chooseDiffMode("auto", null, true).mode === "inline", "폭을 모르면 inline");
  expect(chooseDiffMode("auto", fit - 1, false).mode === "inline" && !chooseDiffMode("auto", fit - 1, true).tooNarrow, "auto 는 tooNarrow 가 아니다");
  expect(chooseDiffMode("inline", fit * 2, true).mode === "inline", "inline 은 늘 inline");
  const narrowSplit = chooseDiffMode("split", fit - 1, true);
  expect(narrowSplit.mode === "inline" && narrowSplit.tooNarrow, "split 이 좁으면 inline 으로 물러나 안내");
  const keptSplit = chooseDiffMode("split", fit - 1, false);
  expect(keptSplit.mode === "split" && !keptSplit.tooNarrow, "자동 전환을 끄면 split 유지");
  return "ok";
});

test("패널 보기 상태: 처음은 트리와 접지 않은 카드, 접기와 펴기는 매번 새 요청 번호", () => {
  const start = getChangesView();
  expect(start.treeView && !start.wordWrap && !start.allCollapsed && !start.wide, "처음은 트리(사용자 선호, View as List 가 목록으로 바꾸는 쪽)");
  setAllDiffsCollapsed(true);
  const first = getChangesView();
  setAllDiffsCollapsed(true);
  const second = getChangesView();
  expect(first.allCollapsed && second.allCollapsed && second.collapseNonce === first.collapseNonce + 1, "같은 값으로 다시 눌러도 카드가 다시 접히도록 번호가 오른다");
  setAllDiffsCollapsed(false);
  expect(!getChangesView().allCollapsed && getChangesView().collapseNonce === first.collapseNonce + 2, "펴기");
  setWordWrap(true);
  setTreeView(true);
  setChangesWide(true);
  const last = getChangesView();
  expect(last.wordWrap && last.treeView && last.wide, "Word Wrap, View as Tree, 넓은 상태가 쌓인다");
  const same = getChangesView();
  setChangesWide(true);
  expect(getChangesView() === same, "같은 wide 값은 상태 객체를 바꾸지 않는다");
  return "ok";
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
