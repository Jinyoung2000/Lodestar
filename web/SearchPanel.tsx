import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { Codicon } from "./icons";
import { buildSearchDoc, searchEditorExtensions, type SearchOpen } from "./searchEditor";
import { highlightPattern } from "./searchText";
import type { SearchRun, SearchToggles, SearchViewOptions } from "./searchViewModel";
import { S } from "./strings";

// 본문 검색의 화면(입력줄, 토글, 포함과 제외, 결과). 상태는 들고 있지 않고 부르는 쪽이 준다.
// 에디터 탭의 Search(web/SearchTab.tsx)는 탭 안 state 로, 왼쪽 사이드바의 Search 뷰(web/SearchView.tsx)는 store 로 이 화면을 감싼다.
// compact 는 사이드바 폭(약 300px)용이다: 컨텍스트 줄 수 입력이 상세 줄로 내려간다.
export type SearchPanelProps = {
  idPrefix: string;
  options: SearchViewOptions;
  run: SearchRun;
  // 검색어는 있는데 아직 결과가 없다(되살린 탭, 다른 폴더에서 돌린 결과)
  stale: boolean;
  compact?: boolean;
  hidden?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  // run 이 true 면 patch 를 적용한 값으로 바로 검색한다
  onChange: (patch: Partial<SearchViewOptions>, run?: boolean) => void;
  onRun: () => void;
  onOpen: SearchOpen;
  // 있으면 결과 자리에 이 안내만 보인다(폴더가 없을 때)
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

// 결과는 읽기 전용 글 편집기 하나다. 경로 줄(밑줄 친 "경로:")의 화살표로 그 파일의 줄들을 접고, 글을 선택하고 복사할 수 있다.
function SearchResults({ result, query, toggles, onOpen }: { result: SearchResultLike; query: string; toggles: SearchToggles; onOpen: SearchOpen }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const doc = useMemo(() => buildSearchDoc(result), [result]);
  const pattern = useMemo(() => highlightPattern(query, toggles), [query, toggles]);
  // 부르는 쪽이 매 렌더 새 함수를 줘도 편집기를 다시 만들지 않는다
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
