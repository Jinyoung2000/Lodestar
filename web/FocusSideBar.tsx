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

// Editor 중심(포커스 모드)의 왼쪽 Primary Side Bar. Activity Bar 에서 고른 뷰(Explorer, Changes, Source Control, Card)를 보인다.
// 뷰 본문은 Chat 중심의 오른쪽 패널이 쓰던 컴포넌트(FilesTab, ChangesPanel, SourceControlTab, CardDetail)를 그대로 쓴다. 폭은 App 이 정한다.
export function FocusSideBar({ width }: { width: number }) {
  const view = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  const activityBar = useLayoutConfig().activityBar;
  return (
    <section className="focus-side" aria-label={S.focusSideAria} data-view={view} style={{ width }}>
      {activityBar && <ActivityBar />}
      <div className="focus-side-head">
        <h2 className="focus-side-title">{S.focusSideTitle[view]}</h2>
        <span className="spacer" />
        {/* Explorer 의 머리줄 단추는 FilesTab 이 이 자리로 portal 한다. FilesTab 은 뷰를 바꿔도 마운트된 채라 자리는 늘 두고 숨기기만 한다. */}
        <span className="focus-side-actions" data-slot="files" role="toolbar" aria-label={S.filesHeaderAria} hidden={view !== "files"} />
        <span className="focus-side-actions" data-slot="scm" role="toolbar" aria-label={S.scmTitleActionsAria} hidden={view !== "scm"} />
        {/* 사이드바는 좁아서(기본 300px) Changes 의 목록 보기 전환만 남는다. 넓은 카드 보기의 단추(최대화, 파일 목록)는 쓰지 않는다. */}
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

// .body 의 폭을 지켜본다. 사이드바 폭을 에디터가 눌리지 않는 범위로 맞추는 데 쓴다. 처음 그릴 때는 0(모름)이다.
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
