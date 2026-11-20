import "./globalSearch.css";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent } from "../shared/protocol";
import { activeAgentOf } from "./activeAgentOf";
import { altLabel, flatRows, mentionItems, parseSlash, searchGroups, slugOf, tabKeyStep, uniquePrs, visibleTabs, type SearchData, type SearchRow, type SearchScope } from "./searchModel";
import { BoardIcon, Chat, CircleFilled, CircleSmallFilled, Close, Codicon, DotSpinner, Filter, Folder, Gear, GoToFile, ListIcon, NoteIcon, Plus, Search } from "./icons";
import { PrStateIcon } from "./PrBits";
import { openPr, usePr } from "./prStore";
import { G } from "./searchStrings";
import { getStamps, startRecentTracking } from "./searchRecents";
import { runCommand } from "./shortcuts";
import { boardShown, slackShown } from "./screenVisibility";
import { ensureFiles, getState, isTopWorkspace, openAgent, openCard, openFile, openImprovements, openInboxItem, openNotes, setState, startCardSession, startDraft, useStore } from "./store";
import { FileTypeIcon } from "./FileTypeIcon";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

// Recent 가 쓰는 "연 시각"은 앱이 뜬 때부터 듣는다(검색창을 처음 열 때부터가 아니라).
startRecentTracking();

// 통합 검색(⌘K). Claude 데스크톱의 Search 창처럼 위에 입력, 유형 탭, 묶음 목록, 아래에 키 안내를 둔다. 계산은 web/searchModel.ts.
export function GlobalSearch({ initialTab }: { initialTab: SearchScope }) {
  const data = useSearchData();
  const tabs = useMemo(() => visibleTabs(data), [data]);
  const [tab, setTab] = useState<SearchScope>(initialTab);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.includes(tab) ? tab : "all";
  const slash = parseSlash(query, tabs);
  const suggestions = slash?.kind === "suggest" ? slash.tabs : null;
  const groups = useMemo(() => (suggestions ? [] : searchGroups(data, activeTab, query)), [data, activeTab, query, suggestions]);
  const rows = useMemo(() => flatRows(groups), [groups]);
  const count = suggestions ? suggestions.length : rows.length;
  const active = Math.min(cursor, Math.max(count - 1, 0));
  const activeRow = suggestions ? undefined : rows[active];
  const alt = activeRow ? altLabel(activeRow) : null;

  useEffect(() => {
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, groups, suggestions]);

  useEffect(() => {
    tabsRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  const pickTab = (next: SearchScope) => {
    setTab(next);
    setCursor(0);
  };

  const pickFilter = (next: SearchScope) => {
    pickTab(next);
    setQuery("");
  };

  const changeQuery = (value: string) => {
    const parsed = parseSlash(value, tabs);
    // "/sessions foo" 는 Sessions 탭으로 좁히고 입력에는 foo 만 남긴다.
    if (parsed?.kind === "scope") {
      pickTab(parsed.tab);
      setQuery(parsed.rest);
      return;
    }
    setQuery(value);
    setCursor(0);
  };

  const compose = () => {
    const workspaceId = getState().activeWorkspaceId ?? getState().workspaces.find(isTopWorkspace)?.id ?? null;
    setState({ overlay: null });
    startDraft(workspaceId, "active", query.trim() ? { text: query } : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const next = tabKeyStep(e, e.currentTarget, tabs, activeTab);
    if (next) {
      e.preventDefault();
      pickTab(next);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (count === 0) return;
      setCursor(e.key === "ArrowDown" ? Math.min(active + 1, count - 1) : Math.max(active - 1, 0));
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (!e.shiftKey) compose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions?.[active]) pickFilter(suggestions[active]);
      else if (activeRow) openRow(activeRow, e.altKey);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && setState({ overlay: null })}>
      <DialogContent label={G.title} className="global-search" aria-describedby={undefined}>
        <div className="gs-head">
          <Search className="gs-search-icon" />
          <input className="gs-field" role="combobox" aria-label={G.title} aria-expanded aria-controls="gs-list" aria-activedescendant={count > 0 ? `gs-row-${active}` : undefined} placeholder={G.placeholder} autoFocus spellCheck={false} value={query} onChange={(e) => changeQuery(e.target.value)} onKeyDown={onKeyDown} />
          <Button size="icon" variant="ghost" aria-label={G.close} title={G.close} onClick={() => setState({ overlay: null })}>
            <Close />
          </Button>
        </div>
        <div className="gs-tabs" role="tablist" aria-label={G.tabsAria} ref={tabsRef}>
          {tabs.map((id) => (
            <button key={id} type="button" role="tab" className="gs-tab" aria-selected={activeTab === id} data-tab={id} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pickTab(id)}>
              {G.tabs[id]}
            </button>
          ))}
        </div>
        <div className="gs-list" id="gs-list" role="listbox" aria-label={G.title} ref={listRef}>
          {suggestions && (
            <div className="gs-group" role="group" aria-label={G.groups.filter}>
              <div className="gs-group-label">{G.groups.filter}</div>
              {suggestions.map((id, i) => (
                <button key={id} id={`gs-row-${i}`} type="button" role="option" aria-selected={active === i} className="gs-row" data-active={active === i || undefined} data-filter={id} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => active !== i && setCursor(i)} onClick={() => pickFilter(id)}>
                  <span className="gs-icon">
                    <Filter />
                  </span>
                  <span className="gs-title">{G.tabs[id]}</span>
                  <span className="gs-muted">/{slugOf(id)}</span>
                </button>
              ))}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="gs-group" role="group" aria-label={group.label}>
              {(activeTab === "all" || group.id === "recent") && <div className="gs-group-label">{group.label}</div>}
              {group.rows.map((row) => {
                const index = rows.indexOf(row);
                return (
                  <button key={row.key} id={`gs-row-${index}`} type="button" role="option" aria-selected={active === index} className="gs-row" data-active={active === index || undefined} data-kind={row.kind} data-key={row.key} onMouseDown={(e) => e.preventDefault()} onMouseMove={() => active !== index && setCursor(index)} onClick={(e) => openRow(row, e.altKey)}>
                    <span className="gs-icon">
                      <RowIcon row={row} />
                    </span>
                    <span className="gs-title">{row.title}</span>
                    {row.muted && <span className="gs-muted">{row.muted}</span>}
                    {active === index ? (
                      <span className="gs-aux gs-enter">
                        <kbd className="keycap">↵</kbd>
                      </span>
                    ) : (
                      <RowAux row={row} />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {count === 0 && <div className="gs-empty">{emptyText(data, activeTab, query, suggestions !== null)}</div>}
        </div>
        <span className="sr-only" role="status">
          {G.resultCount(count)}
        </span>
        <div className="gs-foot">
          <Hint label={G.footer.close} keys={["Esc"]} />
          <Hint label={G.footer.switchType} keys={["←", "→"]} />
          <Hint label={G.footer.filter} keys={["/"]} />
          {alt && <Hint label={alt} keys={["⌥", "↵"]} />}
          <span className="gs-foot-end">
            <Hint label={G.footer.compose} keys={["Tab"]} />
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useSearchData(): SearchData {
  const agents = useStore((s) => s.agents);
  const workspaces = useStore((s) => s.workspaces);
  const recentAgentIds = useStore((s) => s.recentAgentIds);
  const recentFiles = useStore((s) => s.recentFiles);
  const fileWorkspaceId = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents)?.workspaceId ?? s.activeWorkspaceId);
  const files = useStore((s) => (fileWorkspaceId ? s.files[fileWorkspaceId] : undefined));
  const board = useStore((s) => s.board);
  const inbox = useStore((s) => s.inbox);
  const showBoard = useStore((s) => boardShown(s.settings));
  const showSlack = useStore((s) => slackShown(s.settings));
  const lists = usePr((s) => s.lists);
  const [now] = useState(Date.now);
  const [stamps] = useState(getStamps);

  useEffect(() => {
    if (fileWorkspaceId) void ensureFiles(fileWorkspaceId).catch(() => undefined);
  }, [fileWorkspaceId]);

  return useMemo(
    () => ({ agents, workspaces, recentAgentIds, fileWorkspaceId, files, recentFiles, prs: uniquePrs(lists), cards: showBoard ? (board?.cards ?? []) : [], columns: showBoard ? (board?.columns ?? []) : [], mentions: showSlack ? mentionItems(inbox?.items) : [], hiddenActions: [...(showBoard ? [] : ["board"]), ...(showSlack ? [] : ["mentions"])], stamps, now }),
    [agents, workspaces, recentAgentIds, fileWorkspaceId, files, recentFiles, lists, board, inbox, showBoard, showSlack, stamps, now],
  );
}

function emptyText(data: SearchData, tab: SearchScope, query: string, filtering: boolean) {
  if (filtering) return G.noMatchingType;
  if (tab === "files" && data.fileWorkspaceId && !data.files) return G.loadingFiles;
  return query.trim() || tab === "all" ? G.none : G.typeToSearch;
}

// Enter 는 기본 동작, ⌥Enter 는 보조 동작(altLabel 이 이름을 알려 준다).
function openRow(row: SearchRow, alt: boolean) {
  setState({ overlay: null });
  if (row.kind === "session") openAgent(row.agent.id, alt ? "new" : "active");
  else if (row.kind === "file") {
    openFile({ workspaceId: row.workspaceId, path: row.path }, { side: alt });
  } else if (row.kind === "workspace") startDraft(row.workspace.id, alt ? "new" : "active");
  else if (row.kind === "pr") {
    if (alt) window.open(row.pr.url, "_blank");
    else openPr(row.pr.repo, row.pr.number);
  } else if (row.kind === "card") {
    if (alt && row.card.workspaceId) startCardSession(row.card, false);
    else {
      setState({ centerView: "board" });
      openCard(row.card.id);
    }
  } else if (row.kind === "mention") {
    if (alt) window.open(row.item.permalink, "_blank");
    else openInboxItem(row.item.id);
  } else {
    // 대화상자가 닫히며 포커스를 돌려주는 일이 끝난 뒤에 실행해야 입력창 포커스 같은 명령이 묻히지 않는다
    setTimeout(() => runAction(row.command), 0);
  }
}

function runAction(command: string) {
  if (command === "openBoard") setState({ centerView: "board" });
  else if (command === "openMentions") setState({ centerView: "inbox" });
  else if (command === "openNotes") openNotes();
  else if (command === "openImprovements") openImprovements();
  else if (command === "settings") setState({ overlay: { kind: "status" } });
  else runCommand(command);
}

function RowAux({ row }: { row: SearchRow }) {
  if (row.kind === "action" && row.keycaps.length > 0) {
    return (
      <span className="gs-aux">
        {row.keycaps.map((cap, i) => (
          <kbd key={i} className="keycap">
            {cap}
          </kbd>
        ))}
      </span>
    );
  }
  return row.aux ? <span className="gs-aux">{row.aux}</span> : null;
}

function RowIcon({ row }: { row: SearchRow }) {
  if (row.kind === "session") return <SessionDot agent={row.agent} />;
  if (row.kind === "file") return <FileTypeIcon name={row.path} />;
  if (row.kind === "workspace") return <Folder />;
  if (row.kind === "pr") return <PrStateIcon pr={row.pr} />;
  if (row.kind === "card") return <BoardIcon />;
  if (row.kind === "mention") return <Chat />;
  if (row.command === "settings") return <Gear />;
  if (row.command === "openBoard") return <BoardIcon />;
  if (row.command === "openMentions") return <Chat />;
  if (row.command === "openNotes" || row.command === "newNote") return <NoteIcon />;
  if (row.command === "commandPalette") return <ListIcon />;
  if (row.command === "quickOpen") return <GoToFile />;
  if (row.command === "split") return <Codicon name="split-horizontal" />;
  return <Plus />;
}

function SessionDot({ agent }: { agent: Agent }) {
  if (agent.status === "running") return <DotSpinner state="running" />;
  if (agent.status === "waiting") return <DotSpinner state="waiting" />;
  if (agent.status === "error") {
    return (
      <span className="session-dot" data-kind="error">
        <CircleFilled />
      </span>
    );
  }
  if (agent.unread) {
    return (
      <span className="session-dot" data-kind="unread">
        <CircleFilled />
      </span>
    );
  }
  return (
    <span className="session-dot" data-kind="read">
      <CircleSmallFilled />
    </span>
  );
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="gs-hint">
      <span>{label}</span>
      <span className="gs-keys">
        {keys.map((key) => (
          <kbd key={key} className="keycap">
            {key}
          </kbd>
        ))}
      </span>
    </span>
  );
}
