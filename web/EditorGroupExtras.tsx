import { FileTypeIcon } from "./FileTypeIcon";
import { Codicon, More } from "./icons";
import { setDiffView, useDiffView } from "./diffMode";
import { useDiffNav } from "./diffNav";
import { groupIdsOf, MAIN_GROUP, mainTabs, tabsOfGroup } from "./editorGroups";
import { LAYOUT_PRESETS } from "./editorLayoutOps";
import { tabLabel } from "./browserUrl";
import { applyLayoutPreset, closeGroup, closeInGroup, evenGroupSizes, flipGroupLayout, joinAll, joinWithNext, toggleMaximizeGroup } from "./groupActions";
import { useDefaults } from "./defaults";
import { rpc } from "./rpc";
import { runCommand } from "./shortcuts";
import { useCommandKeycaps } from "./commandKeys";
import { focusGroup, getState, setState, shownTabsOf, splitEditor, useStore, type DiffTab, type ScmDiffTab, type Tab } from "./store";
import { defaultChangeScope, type ChangeScope } from "../shared/protocol";
import { M } from "./scmStrings";
import { S } from "./strings";
import { P } from "./prStrings";
import { SV } from "./searchViewStrings";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";


export function tabName(tab: Tab): string {
  if (tab.kind === "search") return S.searchTabTitle(tab.query);
  if (tab.kind === "browser") return tabLabel(tab.title);
  if (tab.kind === "untitled") return S.untitledName(tab.n);
  if (tab.kind === "pr") return P.tabName(tab.number);
  if (tab.kind === "chat") return tab.title || S.newSession;
  const base = tab.path.slice(tab.path.lastIndexOf("/") + 1);
  if (tab.kind === "diff" || tab.kind === "scm") return `${base} (${diffScopeLabel(tab)})`;
  return tab.kind === "replace" ? SV.replacePreviewTitle(base, base) : base;
}

const SCOPE_LABEL: Record<ChangeScope, string> = { branch: S.branchChanges, uncommitted: S.scopeUncommitted, session: S.scopeSession, lastTurn: S.scopeLastTurn };

export function diffScopeLabel(tab: DiffTab | ScmDiffTab): string {
  if (tab.kind === "scm") {
    if (tab.section === "uncommitted") return S.scopeUncommitted;
    return tab.section === "staged" ? M.sectionIndex : M.sectionChanges;
  }
  const agent = getState().agents.find((a) => a.id === tab.agentId);
  return SCOPE_LABEL[tab.scope ?? (agent ? defaultChangeScope(agent) : "branch")];
}

export function GroupMoreMenu({ group, activeKey }: { group: string; activeKey: string | null }) {
  const tabs = useStore((s) => shownTabsOf(s));
  const dirtyTabs = useStore((s) => s.dirtyTabs);
  const groupCount = useStore((s) => groupIdsOf(s.editorLayout).length);
  const isLast = useStore((s) => groupIdsOf(s.editorLayout).at(-1) === group);
  const maximized = useStore((s) => s.maximizedGroup === group);
  const inGroup = group === MAIN_GROUP ? mainTabs(tabs) : tabsOfGroup(tabs, group);
  const active = inGroup.find((t) => t.key === activeKey);
  const previewEditors = useDefaults().previewEditors;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" className="group-more" aria-label={S.groupMore} title={S.groupMore} onPointerDown={() => focusGroup(group)}>
          <More />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="group-menu">
        {(active?.kind === "diff" || active?.kind === "scm") && <DiffMenuItems tabKey={active.key} />}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!inGroup.length}>{S.showOpenedEditors}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent data-testid="opened-editors">
            {inGroup.map((tab) => (
              <DropdownMenuItem key={tab.key} onSelect={() => setState({ activeTabKey: tab.key })} data-active={tab.key === activeKey || undefined}>
                <OpenedEditorLabel tab={tab} dirty={!!dirtyTabs[tab.key]} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!inGroup.length} onSelect={() => void closeInGroup(group, "all")}>
          {S.closeAllTabs}
          <span className="faint xs menu-hint">⌘K W</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!inGroup.length} onSelect={() => void closeInGroup(group, "saved")}>
          {S.closeSavedTabs}
          <span className="faint xs menu-hint">⌘K U</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={previewEditors} onCheckedChange={(on) => void rpc.call("settings.set", { previewEditors: on })} data-testid="menu-enable-preview">
          {S.enablePreviewEditors}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={groupCount < 2} onSelect={() => toggleMaximizeGroup(group)}>
          {maximized ? S.unmaximizeGroup : S.maximizeGroup}
          <span className="faint xs menu-hint">⌘K ⌘M</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!active} onSelect={() => active && splitEditor("row", active.key)}>
          {S.splitRight}
          <span className="faint xs menu-hint">⌘\</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!active} onSelect={() => active && splitEditor("column", active.key)}>
          {S.splitDown}
          <span className="faint xs menu-hint">⌘K ⌘\</span>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{S.editorLayoutMenu}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent data-testid="layout-menu">
            {LAYOUT_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset} onSelect={() => applyLayoutPreset(preset)}>
                {S.layoutNames[preset]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => flipGroupLayout()}>
              {S.flipGroupLayout}
              <span className="faint xs menu-hint">⌥⌘0</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => evenGroupSizes()}>{S.resetGroupSizes}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runCommand("newGroup:right")}>{S.newGroupSide.right}</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={isLast} onSelect={() => joinWithNext(group)}>
          {S.joinWithNext}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={groupCount < 2} onSelect={() => joinAll()}>
          {S.joinAllGroups}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={groupCount < 2 && !inGroup.length} onSelect={() => void closeGroup(group)}>
          {S.closeGroup}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setState({ overlay: { kind: "status" } })}>{S.configureEditors}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OpenedEditorLabel({ tab, dirty }: { tab: Tab; dirty: boolean }) {
  const name = tabName(tab);
  return (
    <>
      <FileTypeIcon name={tab.kind === "file" || tab.kind === "diff" || tab.kind === "scm" || tab.kind === "untitled" || tab.kind === "replace" ? name : ""} />
      <span className="opened-editor-name">{name}</span>
      {dirty && <span className="opened-editor-dot" aria-label={S.tabDirty} />}
    </>
  );
}

function DiffMenuItems({ tabKey }: { tabKey: string }) {
  const [view] = useDiffView();
  const nav = useDiffNav(tabKey);
  return (
    <>
      <DropdownMenuCheckboxItem checked={view === "inline"} onCheckedChange={(inline) => setDiffView(inline ? "inline" : "split")}>
        {S.inlineView}
      </DropdownMenuCheckboxItem>
      {nav?.fileAction && <DropdownMenuItem onSelect={nav.fileAction.run}>{nav.fileAction.label}</DropdownMenuItem>}
      <DropdownMenuSeparator />
    </>
  );
}

export function DiffTabActions({ activeKey }: { activeKey: string | null }) {
  const nav = useDiffNav(activeKey);
  if (!nav) return null;
  return (
    <>
      <Button size="icon" aria-label={S.diffOpenFile} title={S.diffOpenFile} onClick={nav.openFile}>
        <Codicon name="go-to-file" />
      </Button>
      <Button size="icon" aria-label={S.previousChange} title={S.previousChange} onClick={() => nav.step(-1)}>
        <Codicon name="arrow-up" />
      </Button>
      <Button size="icon" aria-label={S.nextChange} title={S.nextChange} onClick={() => nav.step(1)}>
        <Codicon name="arrow-down" />
      </Button>
    </>
  );
}

export function EmptyGroup({ group }: { group: string }) {
  const lonely = useStore((s) => groupIdsOf(s.editorLayout).length < 2);
  return (
    <div className="empty-group" data-testid="empty-group" data-group-empty={group} data-several={!lonely || undefined}>
      <div className="empty-group-commands">
        <EmptyCommandRow command="newSession" icon="comment-discussion" label={S.newSession} run={() => runCommand("newSession")} />
        <EmptyCommandRow command="commandPalette" icon="list-selection" label={S.emptyGroupAllCommands} run={() => runCommand("commandPalette")} />
        <EmptyCommandRow command="quickOpen" icon="go-to-file" label={S.emptyGroupGoToFile} run={() => runCommand("quickOpen")} />
        {!lonely && <EmptyCommandRow command="close" icon="close" label={S.emptyGroupCloseGroup} run={() => void closeGroup(group)} />}
      </div>
    </div>
  );
}

function EmptyCommandRow({ command, icon, label, run }: { command: string; icon: string; label: string; run: () => void }) {
  const keys = useCommandKeycaps(command);
  return (
    <button type="button" className="empty-group-row" onClick={run}>
      <Codicon name={icon} />
      <span className="empty-group-name">{label}</span>
      <span className="empty-group-keys">
        {keys.map((key, index) => (
          <kbd key={index}>{key}</kbd>
        ))}
      </span>
    </button>
  );
}
