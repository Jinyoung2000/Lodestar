import { requestCloseTab } from "./editorDocs";
import { tabName } from "./EditorGroupExtras";
import { FileTypeIcon } from "./FileTypeIcon";
import { Close, Codicon } from "./icons";
import { useStore, type Tab } from "./store";
import { S } from "./strings";
import { commitTabSwitcher, dropTabSwitcherRow, useTabSwitcher } from "./tabSwitcher";
import { tabDescription, type SwitcherRow } from "./tabSwitcherModel";
import "./tabSwitcher.css";

export function RecentEditors() {
  const open = useTabSwitcher();
  const tabs = useStore((s) => s.tabs);
  const dirtyTabs = useStore((s) => s.dirtyTabs);
  if (!open) return null;
  return (
    <div className="tab-switcher" role="listbox" aria-label={S.tabSwitcherAria} data-testid="tab-switcher" data-tab-switcher="" data-scope={open.scope}>
      <div className="tab-switcher-list">
        {open.rows.map((row, index) => {
          const tab = tabs.find((t) => t.key === row.key);
          if (!tab) return null;
          return <SwitcherEntry key={row.key} row={row} tab={tab} selected={index === open.index} separated={row.header && index > 0} dirty={!!dirtyTabs[row.key]} onPick={() => commitTabSwitcher(index)} />;
        })}
      </div>
    </div>
  );
}

function SwitcherEntry({ row, tab, selected, separated, dirty, onPick }: { row: SwitcherRow; tab: Tab; selected: boolean; separated: boolean; dirty: boolean; onPick: () => void }) {
  const name = tabName(tab);
  const path = "path" in tab ? tab.path : undefined;
  const dir = tabDescription(path);
  const preview = "preview" in tab && !!tab.preview;
  return (
    <div
      role="option"
      aria-selected={selected}
      className="tab-switcher-row"
      data-selected={selected || undefined}
      data-separated={separated || undefined}
      data-key={row.key}
      data-group={row.group}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className="tab-switcher-icon">
        <EntryIcon tab={tab} name={name} />
      </span>
      <span className="tab-switcher-name" data-preview={preview || undefined}>
        {name}
      </span>
      {dir && <span className="tab-switcher-dir">{dir}</span>}
      {row.header && <span className="tab-switcher-group">{row.groupName}</span>}
      <button
        type="button"
        className="tab-switcher-close"
        data-dirty={dirty || undefined}
        aria-label={S.closeTab(name)}
        title={S.tabSwitcherClose}
        onClick={(e) => {
          e.stopPropagation();
          void requestCloseTab(row.key).then((closed) => closed && dropTabSwitcherRow(row.key));
        }}
      >
        <Close size={16} />
        <span className="tab-switcher-dot" aria-hidden="true" />
      </button>
    </div>
  );
}

function EntryIcon({ tab, name }: { tab: Tab; name: string }) {
  if (tab.kind === "search") return <Codicon name="search" />;
  if (tab.kind === "browser") return <Codicon name="globe" />;
  if (tab.kind === "pr") return <Codicon name="git-pull-request" />;
  if (tab.kind === "chat") return <Codicon name="comment-discussion" />;
  return <FileTypeIcon name={name} />;
}
