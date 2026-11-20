import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { activeAgentOf } from "./activeAgentOf";
import { FileTypeIcon } from "./FileTypeIcon";
import { Close, Split } from "./icons";
import { Palette } from "./Palette";
import { QUICK_OPEN_NAVIGATE } from "./quickOpenNav";
import { buildPicks, routeOf, splitByRanges, splitLineSuffix, usableRecent, type QuickOpenPick } from "./quickOpenModel";
import type { Range } from "./quickOpenScore";
import { rpc } from "./rpc";
import { activeTab, ensureFiles, forgetRecentFile, openFile, setState, useStore } from "./store";
import { S } from "./strings";

const PAGE_ROWS = 8;

export function QuickOpen() {
  const workspaceId = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents)?.workspaceId ?? s.activeWorkspaceId);
  const workspaceDir = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.dir ?? null);
  const files = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  const recentFiles = useStore((s) => s.recentFiles);
  const includeExcluded = useStore((s) => s.settings?.quickOpenIncludeExcluded ?? false);
  const initialQuery = useStore((s) => s.quickOpenQuery);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ignored, setIgnored] = useState<string[] | null>(null);
  // ⌘P 를 한 번 더 눌러 옮긴 뒤에는 ⌘ 를 떼는 순간 고른 행을 연다
  const armed = useRef(false);

  useEffect(() => {
    if (!workspaceId) return;
    ensureFiles(workspaceId).catch((e: Error) => setLoadError(e.message));
  }, [workspaceId]);

  // 설정에서 기본 제외를 풀면 .gitignore 로 가려진 파일도 가져온다(옛 데몬은 이 요청을 몰라 빈 목록으로 둔다)
  useEffect(() => {
    if (!workspaceId || !includeExcluded) {
      setIgnored(null);
      return;
    }
    rpc.call("files.ignored", { workspaceId }).then(setIgnored, () => setIgnored([]));
  }, [workspaceId, includeExcluded]);

  const allFiles = useMemo(() => (files && ignored?.length ? [...files, ...ignored] : files), [files, ignored]);
  const { filter, line, column } = useMemo(() => splitLineSuffix(query.trim()), [query]);

  const computed = useMemo(() => {
    const start = performance.now();
    const picks = buildPicks({ files: allFiles ?? [], recent: usableRecent(recentFiles, workspaceId, files), filter, workspaceDir, includeExcluded });
    return { picks, ms: performance.now() - start };
  }, [allFiles, recentFiles, workspaceId, files, filter, workspaceDir, includeExcluded]);
  const { history, results } = computed.picks;
  const rows = useMemo(() => [...history, ...results], [history, results]);
  const active = Math.min(index, Math.max(rows.length - 1, 0));
  const activeFile = filter === "" && line !== undefined ? fileOfActiveTab() : null;

  const choose = (pick: QuickOpenPick | undefined, side: boolean) => {
    if (activeFile) {
      setState({ overlay: null });
      openFile({ ...activeFile, line, column }, { side });
      return;
    }
    if (!pick || !workspaceId) return;
    setState({ overlay: null });
    openFile({ workspaceId, path: pick.path, line, column }, { side });
  };

  const remove = (pick: QuickOpenPick) => {
    if (workspaceId) forgetRecentFile({ workspaceId, path: pick.path });
  };

  useEffect(() => {
    document.querySelector(".palette-quickpick [data-file-option][data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  // 한 번 더 누른 ⌘P(다음)와 ⇧⌘P(이전). 옮긴 뒤에는 ⌘ 를 뗄 때 연다.
  useEffect(() => {
    const move = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      armed.current = true;
      setIndex((i) => (rows.length ? (Math.min(i, rows.length - 1) + (next ? 1 : -1) + rows.length) % rows.length : 0));
    };
    const release = () => {
      if (!armed.current) return;
      armed.current = false;
      choose(rows[active], false);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Meta") release();
    };
    window.addEventListener(QUICK_OPEN_NAVIGATE, move);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener(QUICK_OPEN_NAVIGATE, move);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const last = rows.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      armed.current = false;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex(last < 0 ? 0 : (active + step + rows.length) % rows.length);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      setIndex(Math.max(0, Math.min(last, active + (e.key === "PageDown" ? PAGE_ROWS : -PAGE_ROWS))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[active], e.metaKey || e.ctrlKey);
    }
  };

  const onQuery = (value: string) => {
    const route = routeOf(value);
    if (route?.kind === "commands") {
      setState({ overlay: { kind: "commands", query: value } });
      return;
    }
    if (route?.kind === "symbols") {
      setState({ overlay: { kind: "symbols", query: route.query } });
      return;
    }
    armed.current = false;
    setQuery(value);
    setIndex(0);
  };

  const typed = query.trim() !== "";
  return (
    <Palette
      quickpick
      count={typed ? S.resultCount(rows.length) : null}
      label={S.openFile}
      placeholder={workspaceId ? S.openFilePlaceholder : S.openFileNeedsWorkspace}
      query={query}
      onQuery={onQuery}
      onKeyDown={onKeyDown}
      footer={null}
      dialogClassName="quickopen-dialog"
      listboxId="quickopen-list"
      activeOptionId={rows.length ? `quickopen-row-${active}` : undefined}
    >
      <div className="quickopen-list" role="listbox" id="quickopen-list" aria-label={S.quickOpenResultsLabel} data-compute-ms={computed.ms.toFixed(1)} onMouseDown={(e) => e.preventDefault()}>
        {history.map((pick, i) => (
          <QuickOpenRow key={pick.key} pick={pick} id={`quickopen-row-${i}`} active={i === active} groupLabel={i === 0 ? S.recentlyOpened : null} onOpen={choose} onRemove={remove} />
        ))}
        {results.map((pick, i) => (
          <QuickOpenRow key={pick.key} pick={pick} id={`quickopen-row-${history.length + i}`} active={history.length + i === active} groupLabel={i === 0 ? S.quickOpenFileResults : null} separated={i === 0 && history.length > 0} onOpen={choose} onRemove={remove} />
        ))}
        {rows.length === 0 && <QuickOpenEmpty typed={typed} filter={filter} line={line} activeName={activeFile ? activeFile.path.slice(activeFile.path.lastIndexOf("/") + 1) : null} loaded={files !== undefined} loadError={loadError} hasWorkspace={!!workspaceId} />}
      </div>
    </Palette>
  );
}

function QuickOpenRow({ pick, id, active, groupLabel, separated = false, onOpen, onRemove }: { pick: QuickOpenPick; id: string; active: boolean; groupLabel: string | null; separated?: boolean; onOpen: (pick: QuickOpenPick, side: boolean) => void; onRemove: (pick: QuickOpenPick) => void }) {
  const onClick = (e: MouseEvent) => onOpen(pick, e.altKey || e.metaKey || e.ctrlKey);
  return (
    <div role="option" id={id} aria-selected={active} className="quickopen-row" data-file-option data-active={active || undefined} data-separated={separated || undefined} data-recent={pick.recent || undefined} data-path={pick.path} title={pick.description ? `${pick.description}/${pick.label}` : pick.label} onClick={onClick}>
      <span className="quickopen-icon">
        <FileTypeIcon name={pick.label} />
      </span>
      <span className="quickopen-name">
        <Highlighted text={pick.label} ranges={pick.labelMatch} />
      </span>
      {pick.description && (
        <span className="quickopen-dir">
          <Highlighted text={pick.description} ranges={pick.descriptionMatch} />
        </span>
      )}
      <span className="quickopen-actions">
        <button type="button" tabIndex={-1} className="quickopen-action" data-action="side" aria-label={S.openToSide} title={S.quickOpenSideTip} onClick={(e) => { e.stopPropagation(); onOpen(pick, true); }}>
          <Split />
        </button>
        {pick.recent && (
          <button type="button" tabIndex={-1} className="quickopen-action" data-action="remove" aria-label={S.quickOpenRemoveRecent} title={S.quickOpenRemoveRecent} onClick={(e) => { e.stopPropagation(); onRemove(pick); }}>
            <Close />
          </button>
        )}
      </span>
      {groupLabel && <span className="quickpick-section quickopen-group">{groupLabel}</span>}
    </div>
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: Range[] | undefined }) {
  return (
    <>
      {splitByRanges(text, ranges).map((part, i) => (part.hit ? <span key={i} className="quickopen-hit">{part.text}</span> : part.text))}
    </>
  );
}

function QuickOpenEmpty({ typed, filter, line, activeName, loaded, loadError, hasWorkspace }: { typed: boolean; filter: string; line: number | undefined; activeName: string | null; loaded: boolean; loadError: string | null; hasWorkspace: boolean }) {
  let text: string = S.quickOpenNoRecent;
  if (!hasWorkspace) text = S.openFileNeedsWorkspace;
  else if (loadError) text = S.quickOpenLoadFailed(loadError);
  else if (!loaded) text = S.quickOpenLoading;
  else if (filter === "" && line !== undefined) text = activeName ? S.quickOpenGoToLine(line, activeName) : S.quickOpenGoToLineNoFile;
  else if (typed) text = S.quickOpenNoMatches;
  return <div className="quickpick-empty">{text}</div>;
}

// ":12" 처럼 파일 없이 줄만 친 경우에 갈 곳: 지금 보고 있는 에디터 탭의 파일
function fileOfActiveTab() {
  const tab = activeTab();
  return tab?.kind === "file" ? { workspaceId: tab.workspaceId, path: tab.path } : null;
}
