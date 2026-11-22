import { type KeyboardEvent } from "react";
import { keycapsOf } from "./commands";
import { chatHiddenInEditor } from "./focusLayout";
import { Codicon } from "./icons";
import { activeBindings } from "./keymap";
import { PANEL_ALIGNMENTS, SIDE_BAR_POSITIONS, type PanelAlignment, type SideBarPosition } from "./layoutConfig";
import { resetLayoutConfig, setLayoutConfig, useLayoutConfig } from "./layoutConfigStore";
import { runCommand } from "./shortcuts";
import { setState, useStore } from "./store";
import { S } from "./strings";
import { Dialog, DialogContent } from "./ui/dialog";

export function CustomizeLayout() {
  const config = useLayoutConfig();
  const editorLayout = useStore((s) => s.layoutMode === "editor");
  const primaryOn = useStore((s) => (s.layoutMode === "editor" ? s.focusSideOpen : s.sidebarOpen));
  const secondaryOn = useStore((s) => (s.layoutMode === "editor" ? !chatHiddenInEditor(s) : s.rightOpen));
  const panelOn = useStore((s) => s.bottomOpen);
  const close = () => setState({ overlay: null });
  const primaryIcon = config.sideBar === "left" ? "layout-sidebar-left" : "layout-sidebar-right";
  const secondaryIcon = config.sideBar === "left" ? "layout-sidebar-right" : "layout-sidebar-left";
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && close()}>
      <DialogContent
        label={S.customizeLayoutTitle}
        className="palette-quickpick layout-dialog"
        overlayClassName="bg-transparent"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>("[data-layout-row]")?.focus();
        }}
      >
        <div className="layout-title-bar">
          <span className="layout-title">{S.customizeLayoutTitle}</span>
          <button type="button" className="layout-title-button" aria-label={S.restoreLayoutDefaults} title={S.restoreLayoutDefaults} onClick={resetLayoutConfig}>
            <Codicon name="discard" />
          </button>
          <button type="button" className="layout-title-button" aria-label={S.close} title={S.close} onClick={close}>
            <Codicon name="close" />
          </button>
        </div>
        <div className="layout-list" role="menu" aria-label={S.customizeLayoutTitle} onKeyDown={moveFocus}>
          <Section label={S.layoutVisibility}>
            {editorLayout && <ToggleRow icon={config.sideBar === "left" ? "layout-activitybar-left" : "layout-activitybar-right"} label={S.layoutActivityBar} checked={config.activityBar} onSelect={() => setLayoutConfig({ activityBar: !config.activityBar })} />}
            <ToggleRow icon={primaryIcon} label={S.layoutPrimarySideBar} checked={primaryOn} keys="toggleSidebar" onSelect={() => runCommand("toggleSidebar")} />
            <ToggleRow icon={secondaryIcon} label={S.layoutSecondarySideBar} checked={secondaryOn} keys="toggleRight" onSelect={() => runCommand("toggleRight")} />
            <ToggleRow icon="layout-panel" label={S.layoutPanel} checked={panelOn} keys="toggleBottom" onSelect={() => runCommand("toggleBottom")} />
          </Section>
          <Section label={S.layoutSideBarPosition}>
            {SIDE_BAR_POSITIONS.map((position) => (
              <RadioRow key={position} icon={position === "left" ? "layout-sidebar-left" : "layout-sidebar-right"} label={positionLabel(position)} checked={config.sideBar === position} onSelect={() => setLayoutConfig({ sideBar: position })} />
            ))}
          </Section>
          <Section label={S.layoutPanelAlignment}>
            {PANEL_ALIGNMENTS.map((alignment) => (
              <RadioRow key={alignment} icon={`layout-panel-${alignment}`} label={alignmentLabel(alignment)} checked={config.panelAlignment === alignment} onSelect={() => setLayoutConfig({ panelAlignment: alignment })} />
            ))}
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const positionLabel = (position: SideBarPosition) => (position === "left" ? S.layoutLeft : S.layoutRight);
const alignmentLabel = (alignment: PanelAlignment) => ({ left: S.layoutLeft, right: S.layoutRight, center: S.layoutCenter, justify: S.layoutJustify })[alignment];

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-layout-row]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
  rows[next]?.focus();
  event.preventDefault();
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div className="layout-section">{label}</div>
      {children}
    </div>
  );
}

function ToggleRow({ icon, label, checked, keys, onSelect }: { icon: string; label: string; checked: boolean; keys?: string; onSelect: () => void }) {
  return <Row role="menuitemcheckbox" icon={icon} label={label} checked={checked} keys={keys} onSelect={onSelect} />;
}

function RadioRow({ icon, label, checked, onSelect }: { icon: string; label: string; checked: boolean; onSelect: () => void }) {
  return <Row role="menuitemradio" icon={icon} label={label} checked={checked} onSelect={onSelect} />;
}

function Row({ role, icon, label, checked, keys, onSelect }: { role: "menuitemcheckbox" | "menuitemradio"; icon: string; label: string; checked: boolean; keys?: string; onSelect: () => void }) {
  const binding = keys ? activeBindings().find((b) => b.command === keys) : undefined;
  return (
    <button type="button" role={role} aria-checked={checked} aria-label={checked ? `${label} (${S.layoutActive})` : label} className="quickpick-row layout-row" data-layout-row data-checked={checked || undefined} onClick={onSelect}>
      <Codicon name={icon} />
      <span className="quickpick-title">{label}</span>
      {binding && (
        <span className="keycaps">
          {keycapsOf(binding).map((cap, n) => (
            <kbd key={n} className="keycap">
              {cap}
            </kbd>
          ))}
        </span>
      )}
      <span className="layout-check">{checked && <Codicon name="check" />}</span>
    </button>
  );
}
