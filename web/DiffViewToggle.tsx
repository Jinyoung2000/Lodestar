import { InlineDiffIcon, SplitDiffIcon } from "./icons";
import { setDiffView, useDiffView } from "./diffMode";
import { S } from "./strings";
import { Button } from "./ui/button";

// diff 헤더의 Inline / Split 전환. 고른 값이 설정의 diffView 로 저장돼 다음에도 그대로다.
// narrow 는 Split 을 골랐지만 폭이 모자라 지금 Inline 으로 그리고 있다는 뜻이고, 그때는 선택 표시를 그대로 두고 안내만 붙인다.
export function DiffViewToggle({ narrow }: { narrow: boolean }) {
  const [view] = useDiffView();
  return (
    <>
      {narrow && <span className="faint xs">{S.splitNeedsWidth}</span>}
      <div role="group" aria-label={S.diffView} className="inline-flex gap-0.5 p-0.5 border border-border rounded-md">
        <Button size="icon" variant={view === "inline" ? "ghost-on" : "ghost"} aria-label={S.diffInlineTip} aria-pressed={view === "inline"} title={S.diffInlineTip} onClick={() => setDiffView("inline")}>
          <InlineDiffIcon />
        </Button>
        <Button size="icon" variant={view === "split" ? "ghost-on" : "ghost"} aria-label={S.diffSplitTip} aria-pressed={view === "split"} title={S.diffSplitTip} onClick={() => setDiffView("split")}>
          <SplitDiffIcon />
        </Button>
      </div>
    </>
  );
}
