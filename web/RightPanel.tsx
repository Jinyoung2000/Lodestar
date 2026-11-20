import { useState } from "react";
import { WIDE_MIN } from "./ChangesPanel";
import { EditorsWithSide, SideTabs } from "./EditorArea";
import { sideKeyOf } from "./floatLayout";
import { ReferencesPanel } from "./ReferencesPanel";
import { shownTabsOf, useStore } from "./store";
import { S } from "./strings";

export function RightPanel({ width, hidden }: { width: number | string | null; hidden: boolean }) {
  // Editor 중심에서는 에디터가 가운데에 있고 이 패널은 고정 탭(Changes, Files, 카드)만 가진다. 활성 탭은 sideTabKey.
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  const activeTabKey = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  // Chat 중심에서도 에디터 탭이 열려 있으면 왼쪽 에디터와 오른쪽 고정 탭으로 나뉜다. 열린 에디터가 없으면 고정 탭이 패널을 다 쓴다.
  const withEditors = useStore((s) => s.layoutMode !== "editor" && shownTabsOf(s).length > 0);
  // 에디터 그룹이 나뉘어 있으면 좁은 목록 폭으로 시작하지 않는다
  const split = useStore((s) => s.layoutMode !== "editor" && s.editorLayout.type === "split");
  const [maximized, setMaximized] = useState(false);
  // 변경과 파일 탭은 크기를 정하지 않았으면 좁은 상태(--size-panel-narrow)로 시작한다. 에디터와 diff 탭은 넓은 기본 폭을 쓴다.
  const listTab = !split && !withEditors && (activeTabKey === "changes" || activeTabKey === "files" || activeTabKey === "scm" || activeTabKey === "search");
  const panelWidth = maximized ? "100%" : (width ?? (listTab || editorLayout ? "var(--size-panel-narrow)" : undefined));
  const narrow = listTab && !maximized && !(typeof width === "number" && width >= WIDE_MIN);
  return (
    <section className="right" aria-label={S.rightPanelAria} hidden={hidden} style={panelWidth == null ? undefined : { width: panelWidth }}>
      {withEditors ? (
        <EditorsWithSide maximized={maximized} onMaximize={() => setMaximized((m) => !m)} />
      ) : (
        <SideTabs narrow={narrow} maximized={maximized} onMaximize={() => setMaximized((m) => !m)} standalone={!editorLayout} />
      )}
      <ReferencesPanel />
    </section>
  );
}
