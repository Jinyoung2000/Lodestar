import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { Codicon } from "./icons";
import { buildSearchDoc, searchEditorExtensions, type SearchOpen } from "./searchEditor";
import { highlightPattern } from "./searchText";
import type { SearchRun, SearchToggles, SearchViewOptions } from "./searchViewModel";
import { S } from "./strings";

export type SearchPanelProps = {
  idPrefix: string;
  options: SearchViewOptions;
  run: SearchRun;
  stale: boolean;
  compact?: boolean;
  hidden?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<SearchViewOptions>, run?: boolean) => void;
  onRun: () => void;
  onOpen: SearchOpen;
  notice?: string | null;
};

export function SearchPanel({ idPrefix, options, run, stale, compact = false, hidden = false, inputRef, onChange, onRun, onOpen, notice = null }: SearchPanelProps) {
  const toggle = (key: keyof SearchToggles) => onChange({ [key]: !options[key] }, options.query.trim() !== "");
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) onRun();
  };
  const changeContext = (value: string) => {
    const next = Math.max(0, Math.min(5, Number.parseInt(value, 10) || 0));
    onChange({ context: next }, options.query.trim() !== "");
  };
  return (
    <div className="search-tab" data-compact={compact || undefined} hidden={hidden}>
      <div className="search-bar">
        <div className="search-query">
          <input ref={inputRef} className="search-input" aria-label={S.searchPlaceholder} placeholder={S.searchPlaceholder} spellCheck={false} value={options.query} onChange={(e) => onChange({ query: e.target.value })} onKeyDown={onEnter} />
          <ToggleButton label={S.searchMatchCase} icon="case-sensitive" on={options.matchCase} onClick={() => toggle("matchCase")} />
          <ToggleButton label={S.searchWholeWord} icon="whole-word" on={options.wholeWord} onClick={() => toggle("wholeWord")} />
          <ToggleButton label={S.searchRegex} icon="regex" on={options.regex} onClick={() => toggle("regex")} />
        </div>
        {!compact && <ContextInput value={options.context} onChange={changeContext} />}
        <button type="button" className="search-toggle search-details-toggle" aria-label={S.toggleSearchDetails} aria-pressed={options.details} title={S.toggleSearchDetails} onClick={() => onChange({ details: !options.details })}>
          <Codicon name="ellipsis" size={14} />
        </button>
      </div>
      {options.details && (
        <div className="search-details">
          <label className="search-details-label" htmlFor={`${idPrefix}-include`}>
            {S.searchFilesToInclude}
          </label>
          <div className="search-glob-box">
            <input id={`${idPrefix}-include`} className="search-input" aria-label={S.searchIncludePatterns} spellCheck={false} disabled={options.openOnly} value={options.openOnly ? "" : options.include} onChange={(e) => onChange({ include: e.target.value })} onKeyDown={onEnter} />
            <ToggleButton label={S.searchOnlyOpenEditors} icon="book" on={options.openOnly} onClick={() => onChange({ openOnly: !options.openOnly })} />
          </div>
          <label className="search-details-label" htmlFor={`${idPrefix}-exclude`}>
            {S.searchFilesToExclude}
          </label>
          <div className="search-glob-box">
            <input id={`${idPrefix}-exclude`} className="search-input" aria-label={S.searchExcludePatterns} spellCheck={false} value={options.exclude} onChange={(e) => onChange({ exclude: e.target.value })} onKeyDown={onEnter} />
            <ToggleButton label={S.searchUseIgnoreFiles} icon="exclude" on={options.ignore} onClick={() => onChange({ ignore: !options.ignore })} />
          </div>
          {compact && (
            <>
              <label className="search-details-label" htmlFor={`${idPrefix}-context`}>
                {S.searchContextLines}
              </label>
              <ContextInput id={`${idPrefix}-context`} value={options.context} onChange={changeContext} />
            </>
          )}
        </div>
      )}
      {stale && !notice && (
        <div className="search-run-again">
          <button type="button" className="search-run-link" onClick={onRun}>
            {S.searchRunSearch}
          </button>
        </div>
      )}
      <div className="search-results" role="region" aria-label={S.searchResults}>
        {notice && <div className="search-note">{notice}</div>}
        {!notice && run.kind === "idle" && !stale && (
          <div className="search-empty">
            <strong>{S.searchEmptyTitle}</strong>
            <span>{S.searchEmptyHint}</span>
          </div>
        )}
        {!notice && run.kind === "busy" && <div className="search-note">{S.searchRunning}</div>}
        {!notice && run.kind === "error" && <div className="search-note">{run.message}</div>}
        {!notice && run.kind === "done" && (run.result.matches === 0 ? <div className="search-note">{S.searchNoResults}</div> : <SearchResults result={run.result} query={run.query} toggles={run.toggles} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function ContextInput({ id, value, onChange }: { id?: string; value: number; onChange: (value: string) => void }) {
  return <input id={id} className="search-context" type="number" min={0} max={5} aria-label={S.searchContextLines} title={S.searchContextLines} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function ToggleButton({ label, icon, on, onClick }: { label: string; icon: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="search-toggle" aria-label={label} aria-pressed={on} title={label} onClick={onClick}>
      <Codicon name={icon} size={14} />
    </button>
  );
}

function SearchResults({ result, query, toggles, onOpen }: { result: SearchResultLike; query: string; toggles: SearchToggles; onOpen: SearchOpen }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const doc = useMemo(() => buildSearchDoc(result), [result]);
  const pattern = useMemo(() => highlightPattern(query, toggles), [query, toggles]);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc: doc.text, extensions: searchEditorExtensions(doc, pattern, (row, column, pinned, side) => openRef.current(row, column, pinned, side)) }),
    });
    return () => view.destroy();
  }, [doc, pattern]);
  return <div className="search-editor" ref={hostRef} />;
}

type SearchResultLike = Parameters<typeof buildSearchDoc>[0];
