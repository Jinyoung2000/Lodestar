import { useState } from "react";
import { WIDE_MIN } from "./ChangesPanel";
import { EditorsWithSide, SideTabs } from "./EditorArea";
import { sideKeyOf } from "./floatLayout";
import { ReferencesPanel } from "./ReferencesPanel";
import { shownTabsOf, useStore } from "./store";
import { S } from "./strings";

export function RightPanel({ width, hidden }: { width: number | string | null; hidden: boolean }) {
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  const activeTabKey = useStore((s) => sideKeyOf(s.sideTabKey, !!s.selectedCardId));
  const withEditors = useStore((s) => s.layoutMode !== "editor" && shownTabsOf(s).length > 0);
  const split = useStore((s) => s.layoutMode !== "editor" && s.editorLayout.type === "split");
  const [maximized, setMaximized] = useState(false);
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
