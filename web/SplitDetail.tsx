import type { ReactNode } from "react";
import { detailWidthLimits } from "./centerPanels";
import { Close } from "./icons";
import { Resizer } from "./Resizer";
import { setLayout, useStore, type Layout } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";

// 보드와 멘션 화면이 자기 목록 옆에 두는 상세 칸. 세션 오른쪽 패널과 폭이 따로 저장되고, 경계는 세션 화면의 오른쪽 패널 경계와 같은 Resizer 다.
// 상세는 DETAIL_MIN 아래로 줄지 않고, 목록은 창이 넉넉할 때 LIST_MIN 아래로 줄지 않는다(styles.css 의 .split-detail 이 같은 값을 토큰으로 쓴다).
const DETAIL_MIN = 300; // --size-panel-narrow
const LIST_MIN = 300; // --size-chat-floor

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
