import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "./rpc";
import { SearchPanel } from "./SearchPanel";
import { DEFAULT_SEARCH_VIEW, EMPTY_RESULT, buildSearchRequest, togglesOf, type SearchRun, type SearchViewOptions } from "./searchViewModel";
import { openFile, patchSearchTab, toggleSearchDetails, updateSearchTab, useStore, type SearchTab } from "./store";

export function SearchTabView({ tab, active }: { tab: SearchTab; active: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<SearchViewOptions>(() => ({ ...DEFAULT_SEARCH_VIEW, ...tab.seed, query: tab.query, include: tab.include ?? tab.seed?.include ?? "" }));
  const options: SearchViewOptions = { ...local, details: !!tab.details };
  const allTabs = useStore((s) => s.tabs);
  const openPaths = useMemo(() => allTabs.filter((t) => t.kind === "file" && t.workspaceId === tab.workspaceId).map((t) => (t as { path: string }).path), [allTabs, tab.workspaceId]);
  const [run, setRun] = useState<SearchRun>({ kind: "idle" });
  const seq = useRef(0);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [active]);

  const search = async (next: SearchViewOptions) => {
    if (!next.query.trim()) {
      setRun({ kind: "idle" });
      return;
    }
    const mine = ++seq.current;
    setRun({ kind: "busy" });
    updateSearchTab(tab.key, next.query);
    try {
      const request = buildSearchRequest(tab.workspaceId, next, openPaths);
      const result = request ? await rpc.call("files.search", request) : EMPTY_RESULT;
      if (mine === seq.current) setRun({ kind: "done", result, query: next.query, toggles: togglesOf(next), workspaceId: tab.workspaceId });
    } catch (error) {
      if (mine === seq.current) setRun({ kind: "error", message: (error as Error).message });
    }
  };
  useEffect(() => {
    if (!tab.autoRun) return;
    patchSearchTab(tab.key, { autoRun: false });
    void search(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (patch: Partial<SearchViewOptions>, andRun = false) => {
    const merged = { ...options, ...patch };
    if ("details" in patch) toggleSearchDetails(tab.key);
    setLocal(merged);
    if (andRun) void search(merged);
  };
  const stale = options.query.trim() !== "" && run.kind === "idle";

  return (
    <SearchPanel
      idPrefix={tab.key}
      options={options}
      run={run}
      stale={stale}
      hidden={!active}
      inputRef={inputRef}
      onChange={change}
      onRun={() => void search(options)}
      onOpen={(row, column, pinned, side) => openFile({ workspaceId: tab.workspaceId, path: row.path, line: row.line, column }, { preview: !pinned && !side, side })}
    />
  );
}
