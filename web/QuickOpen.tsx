import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { activeAgentOf } from "./activeAgentOf";
import { FileTypeIcon } from "./FileTypeIcon";
import { Close, Split } from "./icons";
import { Palette } from "./Palette";
import { QUICK_OPEN_NAVIGATE } from "./quickOpenNav";
import { buildPicks, routeOf, splitByRanges, splitLineSuffix, usableRecent, type QuickOpenPick } from "./quickOpenModel";
import type { Range } from "./quickOpenScore";
import { rpc } from "./rpc";
import { splitRootPath } from "./searchRoots";
import { isMultiRoot, sessionRoots } from "./sessionFolders";
import { activeTab, ensureFiles, forgetRecentFile, openFile, setState, useStore } from "./store";
import { S } from "./strings";

const PAGE_ROWS = 8;
const ROOT_SEPARATOR = " · ";

function rootPick(pick: QuickOpenPick): QuickOpenPick {
  const cut = pick.description.indexOf("/");
  if (cut === -1) return pick;
  const shift = ROOT_SEPARATOR.length - 1;
  const description = `${pick.description.slice(0, cut)}${ROOT_SEPARATOR}${pick.description.slice(cut + 1)}`;
  const descriptionMatch = pick.descriptionMatch?.map((range) => ({ start: range.start > cut ? range.start + shift : range.start, end: range.end > cut ? range.end + shift : range.end }));
  return { ...pick, description, ...(descriptionMatch ? { descriptionMatch } : {}) };
}

export function QuickOpen() {
  const workspaceId = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents)?.workspaceId ?? s.activeWorkspaceId);
  const workspaceDir = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.dir ?? null);
  const primaryFiles = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  const agent = useStore((s) => activeAgentOf(s.panes, s.activePaneId, s.agents));
  const workspaces = useStore((s) => s.workspaces);
  const fileMap = useStore((s) => s.files);
  const roots = useMemo(() => (agent && isMultiRoot(agent) ? sessionRoots(agent, workspaces).flatMap((r) => (r.workspace ? [{ label: r.label, workspaceId: r.id }] : [])) : null), [agent, workspaces]);
  const rootFiles = useMemo(() => (roots ? (roots.every((r) => fileMap[r.workspaceId]) ? roots.flatMap((r) => fileMap[r.workspaceId].map((path) => `${r.label}/${path}`)) : undefined) : null), [roots, fileMap]);
  const files = rootFiles === null ? primaryFiles : rootFiles;
  const recentFiles = useStore((s) => s.recentFiles);
  const includeExcluded = useStore((s) => s.settings?.quickOpenIncludeExcluded ?? false);
  const initialQuery = useStore((s) => s.quickOpenQuery);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ignored, setIgnored] = useState<string[] | null>(null);
  const armed = useRef(false);

  useEffect(() => {
    if (roots) {
      for (const root of roots) ensureFiles(root.workspaceId).catch((e: Error) => setLoadError(e.message));
      return;
    }
    if (!workspaceId) return;
    ensureFiles(workspaceId).catch((e: Error) => setLoadError(e.message));
  }, [workspaceId, roots]);

  useEffect(() => {
    if (!workspaceId || !includeExcluded || roots) {
      setIgnored(null);
      return;
    }
    rpc.call("files.ignored", { workspaceId }).then(setIgnored, () => setIgnored([]));
  }, [workspaceId, includeExcluded, roots]);

  const allFiles = useMemo(() => (files && ignored?.length ? [...files, ...ignored] : files), [files, ignored]);
  const { filter, line, column } = useMemo(() => splitLineSuffix(query.trim()), [query]);

  const computed = useMemo(() => {
    const start = performance.now();
    const recent = roots ? roots.flatMap((r) => usableRecent(recentFiles, r.workspaceId, fileMap[r.workspaceId]).map((path) => `${r.label}/${path}`)) : usableRecent(recentFiles, workspaceId, files);
    const built = buildPicks({ files: allFiles ?? [], recent, filter, workspaceDir: roots ? null : workspaceDir, includeExcluded });
    const picks = roots ? { ...built, history: built.history.map(rootPick), results: built.results.map(rootPick) } : built;
    return { picks, ms: performance.now() - start };
  }, [allFiles, recentFiles, workspaceId, files, filter, workspaceDir, includeExcluded, roots, fileMap]);
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
    const target = pick ? targetOf(pick) : null;
    if (!target) return;
    setState({ overlay: null });
    openFile({ ...target, line, column }, { side });
  };

  const targetOf = (pick: QuickOpenPick) => {
    if (!roots) return workspaceId ? { workspaceId, path: pick.path } : null;
    const split = splitRootPath(pick.path, roots);
    return split ? { workspaceId: split.root.workspaceId, path: split.rel } : null;
  };

  const remove = (pick: QuickOpenPick) => {
    const target = targetOf(pick);
    if (target) forgetRecentFile(target);
  };

  useEffect(() => {
    document.querySelector(".palette-quickpick [data-file-option][data-active]")?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

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

function fileOfActiveTab() {
  const tab = activeTab();
  return tab?.kind === "file" ? { workspaceId: tab.workspaceId, path: tab.path } : null;
}
