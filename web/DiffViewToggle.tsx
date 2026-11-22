import { InlineDiffIcon, SplitDiffIcon } from "./icons";
import { setDiffView, useDiffView } from "./diffMode";
import { S } from "./strings";
import { Button } from "./ui/button";

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
