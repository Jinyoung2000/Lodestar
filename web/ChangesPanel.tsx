import { PrChecksSection } from "./PrChecksSection";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import "./fileView.css";
import { CHANGE_SCOPES, defaultChangeScope, type Agent, type ChangedFile, type ChangeScope, type DiffView, type ShellNote } from "../shared/protocol";
import { isGeneratedPath } from "../shared/generatedFiles";
import { discardChangedFile, FILE_REVISION_EVENT, keepAllChanges, keepChangedFile, openChangedFile, undoAllChanges } from "./changeCommands";
import { pickChanges, selectChangedFile, setAllDiffsCollapsed, setChangesListOpen, setChangesListWidth, setChangesWide, setChecksOpen, useChangesView } from "./changesState";
import { listNav, type NavRow } from "./changesListNav";
import { BaseLoadFailed, FileDiff, useOriginal } from "./DiffView";
import { pendingOf, sendDiffFeedback, useDiffFeedback } from "./diffFeedbackState";
import { currentDefaults } from "./defaults";
import { setDiffView, splitFits, useDiffView } from "./diffMode";
import { Check, ChevronDownCompact, Close, ChevronRight, Codicon, More } from "./icons";
import { FileTypeIcon, FolderTypeIcon } from "./FileTypeIcon";
import { toTarget } from "./lsp";
import { flash, openChanges, openDiff, refreshGit, refreshPrs, setChangesScope, setShowOutside, shownTabsOf, toggleViewed, useStore, type FolderAgent } from "./store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { ActionButton } from "./ScmRows";
import { S } from "./strings";
import { formatClock } from "./timelineModel";

// 이 폭부터 파일 섹션(diff)과 목록 열이 나란히 보이는 넓은 상태다. 그보다 좁으면 파일 행 목록만 보인다.
export const WIDE_MIN = 440;
// 아직 읽지 않은 변경. 생성 파일 거르기(useMemo)가 렌더마다 새 배열로 다시 돌지 않게 같은 참조를 쓴다.
const NO_FILES: ChangedFile[] = [];

export function ChangesPanel({ agent }: { agent: FolderAgent }) {
  const gitChanges = useStore((s) => s.gitChanges[agent.id]);
  const info = useStore((s) => s.gitInfo[agent.id]);
  const prs = useStore((s) => s.prs[agent.id]);
  const scope = useChangesView((s) => s.scope[agent.id] ?? defaultChangeScope(agent));
  const scoped = useChangesView((s) => s.scoped[agent.id]);
  const listOpen = useChangesView((s) => s.listOpen);
  const selected = useChangesView((s) => s.selected[agent.id]);
  const showOutside = useChangesView((s) => s.showOutside[agent.id] === true);
  const changes = pickChanges(agent, scope, showOutside, scoped, gitChanges);
  const treeView = useChangesView((s) => s.treeView);
  const listOnly = useStore((s) => s.layoutMode === "editor");
  // 열려 있는 diff 탭의 파일(목록에서 그 행이 고른 상태로 보인다). Editor 배치에서만 쓴다.
  const openPath = useStore((s) => {
    if (s.layoutMode !== "editor") return null;
    const tab = s.tabs.find((t) => t.key === s.activeTabKey);
    return tab?.kind === "diff" && tab.agentId === agent.id ? tab.path : null;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  // FIXY: diff 가 DIFF_MIN 아래로 눌리지 않게, 파일 목록 열은 diff 와 같이 들어갈 만큼 넓을 때만 보인다(좁으면 목록 열이 먼저 사라진다)
  const [listFits, setListFits] = useState(false);

  useEffect(() => {
    if (!changes) void refreshGit(agent.id);
    if (!prs) void refreshPrs(agent.id);
  }, [agent.id, changes, prs]);
  // 턴이 시작되거나 끝나면 Last Turn 범위가 달라진다.
  useEffect(() => {
    void refreshGit(agent.id);
  }, [agent.id, agent.status]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const read = () => {
      setWide(!listOnly && root.clientWidth >= WIDE_MIN);
      setListFits(root.clientWidth >= DIFF_MIN + LIST_MIN);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(root);
    return () => observer.disconnect();
  }, [listOnly]);
  useEffect(() => {
    setChangesWide(wide);
    return () => setChangesWide(false);
  }, [wide]);

  // 목록에서 고른 파일의 섹션으로 스크롤한다.
  useEffect(() => {
    if (!wide || !selected) return;
    const section = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-file]") ?? [])].find((el) => el.dataset.file === selected.path);
    section?.scrollIntoView({ block: "start" });
  }, [wide, selected?.nonce, selected?.path, changes]);

  const allFiles = changes?.files ?? NO_FILES;
  const files = useMemo(() => allFiles.filter((f) => !isGeneratedPath(f.path)), [allFiles]);
  // 에디터 탭이 열려 옆으로 갈라진 오른쪽 패널(EditorsWithSide)에서는 패널을 넓혀 카드 보기로 바꾸면 에디터가 눌리므로, 목록에서 고른 파일의 diff 를 에디터 탭으로 연다.
  const beside = useStore((s) => s.layoutMode !== "editor" && shownTabsOf(s).length > 0);
  // 한 번 클릭은 미리보기 탭(다음 클릭이 같은 탭을 바꾼다), 더블클릭과 Enter 는 고정 탭
  // ⌥클릭, ⌥⌘클릭은 옆 그룹에 diff 탭으로 연다
  // Editor 배치는 늘 diff 탭으로 열고, 목록이 보던 범위를 같이 넘겨 탭이 그 범위의 기준과 비교하게 한다.
  const pick = (path: string, preview = true, side = false) => (listOnly || side || beside ? openDiff(agent.id, toTarget(path, agent.workspaceId).workspaceId, path, { preview: preview && !side, side, ...(listOnly ? { scope } : {}) }) : openChanges(path));
  const emptyText = scope === "lastTurn" && changes && changes.base === null ? S.noLastTurn : info?.repoRoot && !info.base && scope === "session" ? S.noBaseCommitCannotCompare : S.noChangedFiles;
  // Editor 배치 목록의 키보드: 위아래는 포커스만 옮기고(열지 않는다), Enter 는 고정 탭으로 연다(행의 onEnter).
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-row]")];
    const at = rows.indexOf(e.target as HTMLElement);
    if (at === -1) return;
    const model: NavRow[] = rows.map((row) => ({ depth: Number(row.dataset.depth ?? 0), folder: row.hasAttribute("aria-expanded"), expanded: row.getAttribute("aria-expanded") === "true" }));
    const action = listNav(e.key, model, at);
    if (!action) return;
    e.preventDefault();
    if (action.type === "toggle") rows[at].click();
    else {
      rows[action.index].focus();
      rows[action.index].scrollIntoView({ block: "nearest" });
    }
  };
  return (
    <div className="changes-view" ref={rootRef} data-wide={wide || undefined} data-list-only={listOnly || undefined}>
      <div className="changes-main">
        <div className="changes-head" data-custom-scope={scope !== defaultChangeScope(agent) || undefined}>
          <ScopeMenu agent={agent} scope={scope} files={files} baseBranch={info?.baseBranch ?? null} baseLabel={scope === "session" ? (info?.baseLabel ?? null) : null} />
          {wide && (
            <>
              <span className="spacer" />
              <ChangesMenu readDiffWidth={() => listRef.current?.querySelector<HTMLElement>(".file-diff-host")?.clientWidth ?? 0} />
            </>
          )}
        </div>
        {files.length > 0 && <KeepUndoRow agent={agent} files={allFiles} />}
        {(showOutside || (changes?.outsideCount ?? 0) > 0) && <OutsideToggle agentId={agent.id} show={showOutside} count={changes?.outsideCount ?? 0} />}
        {scope === "session" && changes?.shellNote && <ShellNoteRow note={changes.shellNote} />}
        <SubmitFeedback agentId={agent.id} />
        <div className="changes-list" ref={listRef} data-wide={wide || undefined} aria-label={listOnly ? S.changedFilesAria : undefined} onKeyDown={listOnly ? onListKey : undefined}>
          {wide
            ? files.map((file) => <FileSection key={`${scope}:${file.path}`} agent={agent} file={file} scope={scope} selected={selected?.path === file.path} />)
            : treeView
              ? <FileTree actionsOf={(file) => sessionActions(agent, file)} files={files} selectedPath={openPath} onPick={(file, e) => pick(file.path, true, !!e?.altKey)} onPin={(file) => pick(file.path, false)} onEnter={listOnly ? (file) => pick(file.path, false) : undefined} />
              : files.map((file) => <FileRow key={file.path} file={file} selected={openPath === file.path} feedbackAgentId={agent.id} actions={sessionActions(agent, file)} onPick={(e) => pick(file.path, true, !!e?.altKey)} onPin={() => pick(file.path, false)} onEnter={listOnly ? () => pick(file.path, false) : undefined} />)}
          {changes && files.length === 0 && (
            <div className="changes-empty">
              <strong>{S.changesEmptyTitle}</strong>
              <span>{emptyText}</span>
            </div>
          )}
          {!changes && <div className="empty-hint">{S.loading}</div>}
        </div>
        {listOnly && <ChecksFold agent={agent} />}
      </div>
      {wide && listOpen && listFits && <ListResizer />}
      {wide && listOpen && listFits && <ChangesTree agent={agent} files={files} />}
    </div>
  );
}

// 머리줄 아래 한 줄의 Keep All 과 Undo All. 보이는 범위의 파일 전부에 한 번에 적용한다. 머리줄 안에 두면 좁은 폭에서 범위 이름을 가려서 자기 줄을 갖는다.
function KeepUndoRow({ agent, files }: { agent: FolderAgent; files: ChangedFile[] }) {
  return (
    <div className="changes-keep-row">
      <Button size="sm" variant="secondary" title={S.keepAllTitle} onClick={() => void keepAllChanges(agent.id, agent.workspaceId, files).catch((e: Error) => flash(e.message))}>
        <Codicon name="check-all" size={12} />
        {S.keepAll}
      </Button>
      <Button size="sm" variant="secondary" title={S.undoAllTitle} onClick={() => void undoAllChanges(agent.id, files).catch((e: Error) => flash(S.discardFailed(e.message), "error"))}>
        <Codicon name="discard" size={12} />
        {S.undoAll}
      </Button>
    </div>
  );
}

function ChangesMenu({ readDiffWidth }: { readDiffWidth: () => number }) {
  const allCollapsed = useChangesView((s) => s.allCollapsed);
  const [view] = useDiffView();
  const [splitNow, setSplitNow] = useState(false);
  return (
    <DropdownMenu onOpenChange={(open) => open && setSplitNow(splitFits(readDiffWidth()))}>
      <DropdownMenuTrigger asChild>
        <Button size="icon" aria-label={S.morePanelActions} title={S.morePanelActions}>
          <More />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setAllDiffsCollapsed(!allCollapsed)}>{allCollapsed ? S.expandAllDiffs : S.collapseAllDiffs}</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{S.diffViewMenu}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DiffViewItem value="inline" current={view} label={S.diffViewInline} />
            <DiffViewItem value="split" current={view} label={S.diffViewSideBySide} />
            <DiffViewItem value="auto" current={view} label={S.diffViewAuto(splitNow ? S.diffViewSideBySide : S.diffViewInline)} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DiffViewItem({ value, current, label }: { value: DiffView; current: DiffView; label: string }) {
  return (
    <DropdownMenuItem className="scope-item" onSelect={() => setDiffView(value)}>
      <span className="scope-item-check">{value === current && <Check size={14} />}</span>
      <span className="scope-item-text">{label}</span>
    </DropdownMenuItem>
  );
}

// B6: 폴더 없는 세션(퀵 챗)은 변경 대상이 없어 늘 빈 상태다.
export function ChatChanges() {
  return (
    <div className="changes-view">
      <div className="changes-main">
        <div className="changes-list">
          <div className="changes-empty">
            <strong>{S.changesEmptyTitle}</strong>
            <span>{S.noChangedFiles}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const changesScope = (agentId: string) => `changes:${agentId}`;

// 모노레포에서 세션의 작업 폴더 밖 변경은 기본으로 목록과 개수에서 빠진다. 빠진 개수를 알리고 켜면 같이 보인다(그 파일은 보기만 된다).
// FIX5-0: 같은 폴더에서 다른 세션이 동시에 돌아 Bash 귀속을 건너뛴 턴이 있었다는 부드러운 안내. 귀속 규칙은 그대로고 어느 턴이었는지만 알린다.
function ShellNoteRow({ note }: { note: ShellNote }) {
  const last = note.turns[note.turns.length - 1];
  return (
    <div className="changes-shell-note" role="note">
      <Codicon name="info" size={12} />
      <span>{S.shellNote(note.turns.length, last.title, formatClock(last.at))}</span>
    </div>
  );
}

function OutsideToggle({ agentId, show, count }: { agentId: string; show: boolean; count: number }) {
  return (
    <label className="changes-outside">
      <Checkbox aria-label={S.showOutsideFolder} checked={show} onCheckedChange={(checked) => setShowOutside(agentId, checked === true)} />
      <span>{S.showOutsideFolder}</span>
      <span className="faint xs">{count}</span>
    </label>
  );
}

// 범위 메뉴 버튼. 라벨, 개수, 변경량을 span 셋으로 두고 사이 구분점은 CSS 가 그린다.
function ScopeMenu({ agent, scope, files, baseBranch, baseLabel }: { agent: Agent; scope: ChangeScope; files: ChangedFile[]; baseBranch: string | null; baseLabel: string | null }) {
  // 피드백 개선 세션은 시작 때 파일 해시가 유일한 기준이라 범위를 고를 수 없다.
  if (agent.feedbackId) {
    return (
      <div className="scope-button" title={baseLabel ?? undefined}>
        <ScopeSummary scope={scope} files={files} />
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="scope-button" aria-label={S.scopeMenuAria} title={baseLabel ?? undefined}>
          <ScopeSummary scope={scope} files={files} />
          <ChevronDownCompact size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="scope-menu">
        {CHANGE_SCOPES.map((value) => (
          <ScopeItem key={value} agent={agent} value={value} current={scope} description={value === "branch" ? baseBranch : SCOPE_TEXT[value].description} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ScopeSummary({ scope, files }: { scope: ChangeScope; files: ChangedFile[] }) {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <>
      <span className="scope-label">{SCOPE_TEXT[scope].title}</span>
      <span className="scope-count">{files.length === 0 ? S.noChangedFilesHead : S.files(files.length)}</span>
      {files.length > 0 && (
        <span className="scope-delta">
          <span className="plus">+{additions}</span> <span className="minus">−{deletions}</span>
        </span>
      )}
    </>
  );
}

const SCOPE_TEXT: Record<ChangeScope, { title: string; description: string | null }> = {
  branch: { title: S.branchChanges, description: null },
  uncommitted: { title: S.scopeUncommitted, description: S.scopeUncommittedDesc },
  session: { title: S.scopeSession, description: S.scopeSessionDesc },
  lastTurn: { title: S.scopeLastTurn, description: S.scopeLastTurnDesc },
};

function ScopeItem({ agent, value, current, description }: { agent: Agent; value: ChangeScope; current: ChangeScope; description: string | null }) {
  return (
    <>
      <DropdownMenuItem className="scope-item" onSelect={() => setChangesScope(agent.id, value)}>
        <span className="scope-item-check">{value === current && <Check size={14} />}</span>
        <span className="scope-item-text">
          <span className="scope-item-title">{SCOPE_TEXT[value].title}</span>
          {description && <span className="scope-item-desc">{description}</span>}
        </span>
      </DropdownMenuItem>
      {value === "uncommitted" && <DropdownMenuSeparator />}
    </>
  );
}

export function FileRow({ file, selected, feedbackAgentId, actions, onPick, onPin, onEnter }: { file: ChangedFile; selected: boolean; feedbackAgentId: string | null; actions: RowActionHandlers; onPick: (event?: { altKey: boolean }) => void; onPin?: () => void; onEnter?: () => void }) {
  const { name, dir } = splitRel(file.rel);
  return (
    <div
      role="button"
      tabIndex={0}
      className="file-row"
      data-nav-row=""
      data-selected={selected || undefined}
      title={file.path}
      onClick={(e) => onPick(e)}
      onDoubleClick={onPin}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          if (e.key === "Enter" && onEnter) onEnter();
          else onPick();
        }
      }}
    >
      <FileTypeIcon name={name} />
      <span className="file-row-name">{name}</span>
      <span className="file-path">{dir}</span>
      <span className="spacer" />
      {feedbackAgentId && <FeedbackBadge agentId={feedbackAgentId} path={file.path} />}
      {file.modifiedSince && <ModifiedSinceMark />}
      <span className="plus xs">+{file.additions}</span>
      <span className="minus xs">−{file.deletions}</span>
      <RowActions actions={actions} />
      <span className="file-status" data-s={file.status}>
        {file.status}
      </span>
    </div>
  );
}

// 행 hover 단추 둘. 열 파일이 없는 행(새 세션 화면의 지워진 파일)에는 Open File 이, onDiscard 가 없는 행(작업 폴더 밖 파일은 보기만 되고, 이름 바뀐 파일은 옛 이름까지 되돌려야 해서 이 단추로는 못 한다)에는 Discard Changes 가 없다.
export type RowActionHandlers = { onOpenFile?: () => void; onKeep?: () => void; onDiscard?: () => void };

function RowActions({ actions }: { actions: RowActionHandlers }) {
  if (!actions.onOpenFile && !actions.onKeep && !actions.onDiscard) return null;
  return (
    <span className="file-row-actions">
      {actions.onOpenFile && <ActionButton label={S.openFile} icon="go-to-file" onClick={actions.onOpenFile} />}
      {actions.onKeep && <ActionButton label={S.keepFileTitle} icon="check" onClick={actions.onKeep} />}
      {actions.onDiscard && <ActionButton label={S.discardChanges} icon="discard" onClick={actions.onDiscard} />}
    </span>
  );
}

// 세션 변경 목록 행의 단추 동작
function sessionActions(agent: FolderAgent, file: ChangedFile): RowActionHandlers {
  return {
    onOpenFile: () => openChangedFile(agent.id, agent.workspaceId, file),
    onKeep: file.outside ? undefined : () => void keepChangedFile(agent.id, agent.workspaceId, file.path).catch((e: Error) => flash(e.message)),
    onDiscard: file.outside || file.status === "R" ? undefined : () => void discardChangedFile(agent.id, file.path, file.rel).catch((e: Error) => flash(S.discardFailed(e.message), "error")),
  };
}

// FIX4A: 에이전트의 마지막 쓰기 뒤 바뀐 파일의 표시. Undo 가 이 파일을 건너뛴다.
function ModifiedSinceMark() {
  return (
    <span className="changes-modified-since" title={S.changedSinceEdit} data-testid="modified-since">
      <Codicon name="warning" size={12} />
    </span>
  );
}

function FeedbackBadge({ agentId, path }: { agentId: string; path: string }) {
  const count = pendingOf(useDiffFeedback(agentId)).filter((f) => f.path === path).length;
  if (count === 0) return null;
  return (
    <span className="changes-feedback-badge" title={S.fbCommentCount(count)} data-testid="feedback-badge">
      <Codicon name="comment" size={12} />
      <span>{count}</span>
    </span>
  );
}

function SubmitFeedback({ agentId }: { agentId: string }) {
  const count = pendingOf(useDiffFeedback(agentId)).length;
  if (count === 0) return null;
  const label = S.fbSubmitCount(count);
  return (
    <div className="changes-submit-row">
      <Button size="sm" variant="primary" aria-label={label} title={S.fbSubmit} onClick={() => void sendDiffFeedback(agentId, "", currentDefaults().requestQueuing === "steer").catch((e: Error) => flash(e.message))}>
        <Codicon name="comment" size={12} />
        {label}
      </Button>
    </div>
  );
}

function FileSection({ agent, file, scope, selected }: { agent: FolderAgent; file: ChangedFile; scope: ChangeScope; selected: boolean }) {
  const viewed = useStore((s) => s.viewed[agent.id]?.includes(file.path) ?? false);
  const sectionRef = useRef<HTMLDetailsElement>(null);
  const near = useNearList(sectionRef);
  const [open, setOpen] = useState(!viewed);
  const live = open && near;
  const { loaded, original, error, retry } = useOriginal(agent.id, file.path, scope, file, live);
  const diffRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);
  useEffect(() => {
    const el = diffRef.current;
    if (!live || !el) return;
    const observer = new ResizeObserver(() => {
      if (el.offsetHeight > 0) lastHeight.current = el.offsetHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [live]);
  const [collapse, setCollapse] = useState(true);
  const wrap = useChangesView((s) => s.wordWrap);
  // 패널 `...` 의 Collapse All Diffs 와 Expand All Diffs 는 카드마다 자기 접힘 상태를 덮어쓴다.
  const collapseNonce = useChangesView((s) => s.collapseNonce);
  const allCollapsed = useChangesView((s) => s.allCollapsed);
  const seenNonce = useRef(collapseNonce);
  useEffect(() => {
    if (seenNonce.current === collapseNonce) return;
    seenNonce.current = collapseNonce;
    setOpen(!allCollapsed);
  }, [collapseNonce, allCollapsed]);
  // 팔레트의 Keep 이나 Undo 뒤에 diff 를 새 기준과 디스크 내용으로 다시 만든다.
  const [revision, setRevision] = useState(0);
  const { name, dir } = splitRel(file.rel);
  const target = toTarget(file.path, agent.workspaceId);
  useEffect(() => {
    const onRevision = (event: Event) => {
      const detail = (event as CustomEvent<{ agentId: string; path: string }>).detail;
      if (detail.agentId === agent.id && detail.path === file.path) setRevision((n) => n + 1);
    };
    window.addEventListener(FILE_REVISION_EVENT, onRevision);
    return () => window.removeEventListener(FILE_REVISION_EVENT, onRevision);
  }, [agent.id, file.path]);
  const openTarget = () => openChangedFile(agent.id, agent.workspaceId, file);
  return (
    <details ref={sectionRef} className="file-section" data-file={file.path} data-selected={selected || undefined} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary onClick={() => selectChangedFile(agent.id, file.path)}>
        <span className="chev">
          <ChevronRight />
        </span>
        <FileTypeIcon name={name} />
        <button
          type="button"
          className="file-name"
          title={S.openInEditor}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openTarget();
          }}
        >
          {name}
        </button>
        <span className="file-path" title={file.outside ? S.outsideFolderReadOnly : undefined}>
          {dir}
        </span>
        <span className="spacer" />
        {file.modifiedSince && <ModifiedSinceMark />}
        <span className="plus xs">+{file.additions}</span>
        <span className="minus xs">−{file.deletions}</span>
        <span className="file-status" data-s={file.status}>
          {file.status}
        </span>
        <FeedbackBadge agentId={agent.id} path={file.path} />
        <span className="file-actions">
          <Button
            size="icon"
            variant={collapse ? "ghost" : "ghost-on"}
            aria-label={S.collapseUnchanged}
            aria-pressed={collapse}
            title={S.collapseUnchanged}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCollapse((c) => !c);
            }}
          >
            <Codicon name="fold" />
          </Button>
          <Button
            size="icon"
            aria-label={S.openFile}
            title={S.openFile}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openTarget();
            }}
          >
            <Codicon name="go-to-file" />
          </Button>
        </span>
        <label className="viewed" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            aria-label={S.viewedAria(file.rel)}
            checked={viewed}
            onCheckedChange={() => {
              toggleViewed(agent.id, file.path);
              setOpen(viewed);
            }}
          />
          {S.viewed}
        </label>
      </summary>
      {open && !near && <div className="file-diff" aria-hidden style={{ height: lastHeight.current ?? (file.additions + file.deletions + IDLE_CONTEXT_LINES) * IDLE_LINE_PX }} />}
      {live && (
        <div className="file-diff" ref={diffRef}>
          {file.status === "D" ? (
            <div className="diff-empty">{S.deletedFile(file.deletions)}</div>
          ) : error ? (
            <BaseLoadFailed message={error} onRetry={retry} />
          ) : loaded ? (
            <FileDiff key={revision} agentId={agent.id} workspaceId={target.workspaceId} path={file.path} original={original} scope={changesScope(agent.id)} collapse={collapse} wrap={wrap} readOnly={file.outside} />
          ) : (
            <div className="diff-empty">{S.loadingBase}</div>
          )}
        </div>
      )}
    </details>
  );
}

// 화면 밖 카드 빈 칸의 첫 높이 짐작. 바뀐 줄 수에 접히지 않는 앞뒤 문맥 몇 줄을 더한다. 넘치면 .file-diff 의 max-height 가 자른다.
const IDLE_LINE_PX = 19;
const IDLE_CONTEXT_LINES = 6;
// 목록 화면 위아래로 이만큼 안에 든 카드는 미리 띄운다(스크롤하다 빈 칸이 보이지 않게).
// lint-tokens: allow IntersectionObserver rootMargin 은 CSS 변수를 못 쓰고 px 문자열만 받는다
const NEAR_MARGIN = "1200px 0px";
// 멀어진 카드는 이만큼 뒤에 내린다. 덩어리 Undo 의 디스크 쓰기(150ms 대기)가 끝나기 전에 에디터가 사라지지 않게 하고, 위아래로 잠깐 오갈 때 다시 만들지 않는다.
const FAR_DELAY_MS = 1500;

// 카드가 Changes 목록(스크롤 칸) 화면 근처에 있는가. 들어오면 바로 true, 멀어지면 FAR_DELAY_MS 뒤에 false.
function useNearList(ref: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (entry.isIntersecting) setNear(true);
        else timer = setTimeout(() => setNear(false), FAR_DELAY_MS);
      },
      { root: el.closest(".changes-list"), rootMargin: NEAR_MARGIN },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [ref]);
  return near;
}

// 맨 오른쪽 열(--size-changes-list): 바뀐 파일 목록과 Checks. 목록은 기본이 평평한 행이고, 탭줄 `...` 의 View as Tree 를 켜면 폴더 트리다. 파일 행은 그 카드로 스크롤한다.
function ChangesTree({ agent, files }: { agent: FolderAgent; files: ChangedFile[] }) {
  const selected = useChangesView((s) => s.selected[agent.id]);
  const treeView = useChangesView((s) => s.treeView);
  const listWidth = useChangesView((s) => s.listWidth);
  return (
    <div className="changes-tree" style={listWidth ? { width: listWidth } : undefined}>
      <div className="tree-head">
        <span className="tree-title">{S.changesFiles}</span>
        <Button size="icon" aria-label={S.closeFileList} title={S.closeFileList} onClick={() => setChangesListOpen(false)}>
          <Close size={14} />
        </Button>
      </div>
      {treeView ? <FileTree actionsOf={(file) => sessionActions(agent, file)} files={files} selectedPath={selected?.path ?? null} onPick={(file) => selectChangedFile(agent.id, file.path)} /> : files.map((file) => <FileRow key={file.path} file={file} selected={selected?.path === file.path} feedbackAgentId={agent.id} actions={sessionActions(agent, file)} onPick={() => selectChangedFile(agent.id, file.path)} />)}
      <div className="tree-title">{S.changesChecks}</div>
      <PrChecksSection agent={agent} />
    </div>
  );
}

// Editor 배치 목록 아래의 접히는 Checks 구역. 넓은 카드 보기의 오른쪽 열(ChangesTree)에만 있던 PR 과 체크 목록을 옮겨 왔다.
// 접혀 있으면 PrChecksSection 을 그리지 않아서 PR 과 체크를 60초마다 읽는 일도 펼칠 때부터 시작한다.
function ChecksFold({ agent }: { agent: FolderAgent }) {
  const open = useChangesView((s) => s.checksOpen);
  return (
    <section className="changes-checks" data-open={open || undefined} aria-label={S.changesChecks}>
      <button type="button" className="tree-node changes-checks-toggle" aria-expanded={open} onClick={() => setChecksOpen(!open)}>
        <span className="chev" data-collapsed={!open || undefined}>
          <ChevronRight size={14} />
        </span>
        <span className="changes-checks-title">{S.changesChecks}</span>
      </button>
      {open && (
        <div className="changes-checks-body">
          <PrChecksSection agent={agent} />
        </div>
      )}
    </section>
  );
}

const LIST_MIN = 200; // --size-changes-list-min
const LIST_MAX = 400;
const DIFF_MIN = 360; // --size-changes-diff-min

// 파일 목록 열 왼쪽 경계 끌기. 왼쪽으로 끌수록 열이 넓어지고, 더블클릭은 기본 폭으로 되돌린다.
function ListResizer() {
  const [active, setActive] = useState(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const tree = event.currentTarget.nextElementSibling;
    if (!tree || event.button !== 0) return;
    const startSize = tree.getBoundingClientRect().width;
    const startX = event.clientX;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 합성 PointerEvent 는 캡처가 거절된다. window 리스너로 끝까지 따라가므로 없어도 된다.
    }
    setActive(true);
    const move = (e: PointerEvent) => setChangesListWidth(Math.round(Math.min(Math.max(startSize + startX - e.clientX, LIST_MIN), LIST_MAX)));
    const up = () => {
      setActive(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="resizer" role="separator" aria-label={S.resizeFileList} aria-orientation="vertical" data-axis="x" data-active={active || undefined} onPointerDown={onPointerDown} onDoubleClick={() => setChangesListWidth(null)} />;
}

// 폴더 트리. 트리 행 22px, 깊이마다 space-3 들여쓰기. 파일 행을 누르면 onPick 이 불린다.
export function FileTree({ actionsOf, files, selectedPath, onPick, onPin, onEnter }: { actionsOf: (file: ChangedFile) => RowActionHandlers; files: ChangedFile[]; selectedPath: string | null; onPick: (file: ChangedFile, event?: { altKey: boolean }) => void; onPin?: (file: ChangedFile) => void; onEnter?: (file: ChangedFile) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);
  const toggle = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  const indent = (depth: number) => ({ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-3))` });
  const render = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.file) {
      const file = node.file;
      return (
        <div
          key={node.path}
          role="button"
          tabIndex={0}
          className="tree-node"
          data-nav-row=""
          data-depth={depth}
          data-selected={selectedPath === file.path || undefined}
          style={indent(depth)}
          title={file.rel}
          onClick={(e) => onPick(file, e)}
          onDoubleClick={() => onPin?.(file)}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              if (e.key === "Enter" && onEnter) onEnter(file);
              else onPick(file);
            }
          }}
        >
          <FileTypeIcon name={node.name} />
          <span className="name">{node.name}</span>
          <RowActions actions={actionsOf(file)} />
          <span className="file-status" data-s={file.status}>
            {file.status}
          </span>
        </div>
      );
    }
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path}>
        <button type="button" className="tree-node" data-nav-row="" data-depth={depth} aria-expanded={!isCollapsed} style={indent(depth)} onClick={() => toggle(node.path)}>
          <span className="chev" data-collapsed={isCollapsed || undefined}>
            <ChevronRight size={14} />
          </span>
          <FolderTypeIcon name={node.name} open={!isCollapsed} />
          <span className="name">{node.name}</span>
        </button>
        {!isCollapsed && node.children.map((child) => render(child, depth + 1))}
      </div>
    );
  };
  return <>{tree.children.map((child) => render(child, 0))}</>;
}

function splitRel(rel: string) {
  const slash = rel.lastIndexOf("/");
  return { name: rel.slice(slash + 1), dir: slash === -1 ? "" : rel.slice(0, slash) };
}

type TreeNode = { name: string; path: string; children: TreeNode[]; file: ChangedFile | null };

function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], file: null };
  for (const file of files) {
    const parts = file.rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.path === path);
      if (!child) {
        child = { name: parts[i], path, children: [], file: i === parts.length - 1 ? file : null };
        node.children.push(child);
      }
      node = child;
    }
  }
  // 하위 폴더가 하나뿐인 폴더는 합쳐서 "a/b" 로 보여 준다.
  const squash = (node: TreeNode): TreeNode => {
    node.children = node.children.map(squash);
    if (!node.file && node.children.length === 1 && !node.children[0].file && node.path) {
      const only = node.children[0];
      return { ...only, name: `${node.name}/${only.name}` };
    }
    return node;
  };
  root.children = root.children.map(squash).sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
  return root;
}
