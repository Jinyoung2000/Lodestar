import type { ReactNode } from "react";
import { detailWidthLimits } from "./centerPanels";
import { Close } from "./icons";
import { Resizer } from "./Resizer";
import { setLayout, useStore, type Layout } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

const DETAIL_MIN = 300;
const LIST_MIN = 300;

type WidthKey = "inboxDetailWidth" | "boardDetailWidth" | "improvementsDetailWidth" | "notionChatWidth";

export function SplitDetail({ widthKey, label, title, closeLabel, onClose, compact = false, actions, children }: { widthKey: WidthKey; label: string; title: string; closeLabel: string; onClose: (() => void) | null; compact?: boolean; actions?: ReactNode; children: ReactNode }) {
  const width = useStore((s) => s.layout[widthKey]);
  const container = () => document.querySelector(".split-view")?.getBoundingClientRect().width ?? 0;
  return (
    <>
      <Resizer axis="x" label={S.resizeDetail} target=".split-detail" direction={-1} min={DETAIL_MIN} max={() => detailWidthLimits(container(), DETAIL_MIN, LIST_MIN).max} onSize={(px) => setLayout({ [widthKey]: px } as Partial<Layout>)} />
      <section className="split-detail" data-compact={compact || undefined} aria-label={label} style={width == null ? undefined : { width }}>
        <div className="pane-header">
          <span className="agent-title">{title}</span>
          <span className="spacer" />
          {actions}
          {onClose && (
            <Button size="icon" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
              <Close size={14} />
            </Button>
          )}
        </div>
        <div className="split-detail-body">{children}</div>
      </section>
    </>
  );
}
