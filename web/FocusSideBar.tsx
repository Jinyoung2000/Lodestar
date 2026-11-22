import { useLayoutEffect, useState } from "react";
import { ActivityBar } from "./ActivityBar";
import { MainActions, PinnedBodies } from "./EditorArea";
import { ReferencesPanel } from "./ReferencesPanel";
import { Close } from "./icons";
import { useLayoutConfig } from "./layoutConfigStore";
import { sideKeyOf } from "./floatLayout";
import { closeCard, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import "./focusLayout.css";

export function FocusSideBar({ width }: { width: number }) {
  const view = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  const activityBar = useLayoutConfig().activityBar;
  return (
    <section className="focus-side" aria-label={S.focusSideAria} data-view={view} style={{ width }}>
      {activityBar && <ActivityBar />}
      <div className="focus-side-head">
        <h2 className="focus-side-title">{S.focusSideTitle[view]}</h2>
        <span className="spacer" />
        <span className="focus-side-actions" data-slot="files" role="toolbar" aria-label={S.filesHeaderAria} hidden={view !== "files"} />
        <span className="focus-side-actions" data-slot="scm" role="toolbar" aria-label={S.scmTitleActionsAria} hidden={view !== "scm"} />
        <MainActions changesTab={view === "changes"} searchTab={view === "search"} narrow maximized={false} onMaximize={() => undefined} maximize={false} />
        {view === "card" && (
          <Button size="icon" aria-label={S.closeCard} title={S.closeCard} onClick={() => closeCard()}>
            <Close />
          </Button>
        )}
      </div>
      <div className="right-body focus-side-body" data-group-body="side">
        <PinnedBodies activeKey={view} withQuick={false} />
      </div>
      <ReferencesPanel />
    </section>
  );
}

export function useBodyWidth(): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const body = document.querySelector<HTMLElement>(".body");
    if (!body) return;
    const measure = () => setWidth(Math.round(body.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  return width;
}
