import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { addToHistory, cancelSearchView, canCollapse, clearSearchView, collapseAll, expandAll, historyOf, openNewSearchEditor, openSearchInEditor, runSearchView, scheduleSearchView, setViewMode, type HistoryKind } from "./findInFiles";
import { Codicon } from "./icons";
import { revealCursor, SearchResults } from "./SearchResults";
import { replaceAll, searchAgain } from "./searchReplaceActions";
import { currentModel, setSearchUi, useSearchUi, viewModeOf } from "./searchState";
import { IDLE_RUN, needsRunLink, regexError, runIsCurrent, typingDelay, type SearchRun, type SearchViewOptions } from "./searchViewModel";
import { SV, noResults, resultCount } from "./searchViewStrings";
import { searchWorkspaceOf, setState, updateSearchView, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import "./searchView.css";

export function SearchView() {
  const view = useStore((s) => s.searchView);
  const run = useStore((s) => s.searchRun);
  const workspaceId = useStore(searchWorkspaceOf);
  const settings = useSearchUi((s) => s.settings);
  const phase = useSearchUi((s) => s.phase);
  const focusRequest = useStore((s) => s.focusSearchInput);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusRequest(focusRequest, inputRef);

  const shown = run.kind === "done" && !runIsCurrent(run, workspaceId) ? IDLE_RUN : run;
  return (
    <>
      <div className="files-header sv-toolbar" role="toolbar" aria-label={SV.actionsAria}>
        <span className="spacer" />
        <SearchHeaderActions />
      </div>
      <div className="search-view" aria-label={S.focusSideTitle.search} data-actions={settings.actionsPosition}>
        <SearchWidget view={view} hasResults={shown.kind === "done" && shown.result.matches > 0} resultQuery={shown.kind === "done" ? shown.query : null} inputRef={inputRef} listRef={listRef} />
        {view.details && <SearchDetails view={view} />}
        <div className="sv-progress" data-active={phase !== 0 || undefined} role="progressbar" aria-hidden={phase === 0} />
        <SearchMessage view={view} run={shown} stale={needsRunLink(view, shown, workspaceId)} noFolder={!workspaceId} />
        {workspaceId && <SearchResults listRef={listRef} inputRef={inputRef} />}
      </div>
    </>
  );
}

export function SearchHeaderActions() {
  const view = useStore((s) => s.searchView);
  const run = useStore((s) => s.searchRun);
  const phase = useSearchUi((s) => s.phase);
  const settings = useSearchUi((s) => s.settings);
  const model = useSearchUiModel();
  const collapsed = useSearchUi((s) => s.collapsed);
  const hasResults = run.kind === "done" && model.hitCount > 0;
  const tree = viewModeOf(view.viewMode, settings) === "tree";
  const collapsible = useMemo(() => canCollapse(), [model, collapsed]);
  const hasPattern = view.query !== "" || view.replaceText !== "" || view.include !== "" || view.exclude !== "";
  return (
    <>
      {phase === 2 ? (
        <Button size="icon" aria-label={SV.cancelSearch} title={SV.cancelSearch} onClick={cancelSearchView}>
          <Codicon name="search-stop" />
        </Button>
      ) : (
        <Button size="icon" aria-label={SV.refresh} title={SV.refresh} disabled={view.query === ""} onClick={() => {
            void runSearchView();
            setState({ focusSearchInput: Date.now() });
          }}>
          <Codicon name="refresh" />
        </Button>
      )}
      <Button size="icon" aria-label={SV.clearResults} title={SV.clearResults} disabled={!hasPattern} onClick={clearSearchView}>
        <Codicon name="clear-all" />
      </Button>
      <Button size="icon" aria-label={SV.openNewEditor} title={SV.openNewEditor} onClick={openNewSearchEditor}>
        <Codicon name="new-file" />
      </Button>
      <Button size="icon" aria-label={tree ? SV.viewAsList : SV.viewAsTree} title={tree ? SV.viewAsList : SV.viewAsTree} disabled={!hasResults} onClick={() => setViewMode(tree ? "list" : "tree")}>
        <Codicon name={tree ? "list-tree" : "list-flat"} />
      </Button>
      {collapsible ? (
        <Button size="icon" aria-label={SV.collapseAll} title={SV.collapseAll} disabled={!hasResults} onClick={collapseAll}>
          <Codicon name="collapse-all" />
        </Button>
      ) : (
        <Button size="icon" aria-label={SV.expandAll} title={SV.expandAll} disabled={!hasResults} onClick={expandAll}>
          <Codicon name="expand-all" />
        </Button>
      )}
    </>
  );
}

function useSearchUiModel() {
  const run = useStore((s) => s.searchRun);
  const mode = useStore((s) => s.searchView.viewMode);
  const dismissed = useSearchUi((s) => s.dismissed);
  const settings = useSearchUi((s) => s.settings);
  const workspaceId = useStore(searchWorkspaceOf);
  return useMemo(() => currentModel(), [run, mode, dismissed, settings, workspaceId]);
}

function SearchWidget({ view, hasResults, resultQuery, inputRef, listRef }: { view: SearchViewOptions; hasResults: boolean; resultQuery: string | null; inputRef: RefObject<HTMLTextAreaElement | null>; listRef: RefObject<HTMLDivElement | null> }) {
  const settings = useSearchUi((s) => s.settings);
  const replaceInputRef = useRef<HTMLTextAreaElement>(null);
  const error = regexError(view.query, view.regex);

  const toggle = (patch: Partial<SearchViewOptions>) => {
    updateSearchView(patch);
    queueMicrotask(() => scheduleSearchView(0));
  };
  const typed = (query: string) => {
    updateSearchView({ query });
    setSearchUi({ note: null });
    historyOf("search").reset();
    if (!settings.searchOnType) return;
    const delay = typingDelay({ query, regex: view.regex }, settings.searchOnTypeDebouncePeriod);
    if (delay !== null) scheduleSearchView(delay);
  };
  const submit = () => {
    addToHistory("search", view.query);
    if (error === null) void runSearchView();
  };
  const dirty = resultQuery !== view.query;
  return (
    <div className="sv-widgets" onKeyDown={(e) => widgetKey(e, toggle, view)}>
      <div className="sv-widget">
        <button type="button" className="sv-replace-toggle" aria-label={SV.toggleReplace} title={SV.toggleReplace} aria-expanded={view.showReplace} onClick={() => updateSearchView({ showReplace: !view.showReplace })}>
          <Codicon name={view.showReplace ? "chevron-down" : "chevron-right"} />
        </button>
        <div className="sv-fields">
          <InputBox
            inputRef={inputRef}
            value={view.query}
            placeholder={SV.placeholderSearch}
            label={SV.ariaSearch}
            history="search"
            error={error}
            onChange={typed}
            onHistory={(query) => {
              updateSearchView({ query });
              if (query === "") scheduleSearchView(settings.searchOnTypeDebouncePeriod);
            }}
            onSubmit={submit}
            onCancel={() => cancelSearchView()}
            onTab={(e) => {
              if (!e.shiftKey && view.showReplace) {
                e.preventDefault();
                replaceInputRef.current?.focus();
              }
            }}
            onFocusResults={() => focusResults(listRef)}
          >
            <Toggle label={SV.matchCase} keys="⌥⌘C" icon="case-sensitive" on={view.matchCase} onChange={(on) => toggle({ matchCase: on })} />
            <Toggle label={SV.matchWholeWord} keys="⌥⌘W" icon="whole-word" on={view.wholeWord} onChange={(on) => toggle({ wholeWord: on })} />
            <Toggle label={SV.useRegex} keys="⌥⌘R" icon="regex" on={view.regex} onChange={(on) => toggle({ regex: on })} />
          </InputBox>
          {view.showReplace && (
            <div className="sv-replace-row">
              <InputBox
                inputRef={replaceInputRef}
                value={view.replaceText}
                placeholder={SV.placeholderReplace}
                label={SV.ariaReplace}
                history="replace"
                error={null}
                onChange={(replaceText) => updateSearchView({ replaceText })}
                onHistory={(replaceText) => updateSearchView({ replaceText })}
                onSubmit={() => {
                  addToHistory("replace", view.replaceText);
                  void runSearchView();
                }}
                onCancel={() => {
                  updateSearchView({ showReplace: false });
                  inputRef.current?.focus();
                }}
                onTab={(e) => {
                  if (e.shiftKey) {
                    e.preventDefault();
                    inputRef.current?.focus();
                  }
                }}
                onFocusResults={() => focusResults(listRef)}
              >
                <Toggle label={SV.preserveCase} keys="⌥⌘P" icon="preserve-case" on={view.preserveCase} onChange={(on) => updateSearchView({ preserveCase: on })} />
              </InputBox>
              <button type="button" className="sv-replace-all" aria-label={hasResults && !dirty ? SV.withKey(SV.replaceAll, "⌥⌘Enter") : SV.replaceAllDisabled} title={hasResults && !dirty ? SV.withKey(SV.replaceAll, "⌥⌘Enter") : SV.replaceAllDisabled} disabled={!hasResults || dirty} onClick={() => void replaceAll()}>
                <Codicon name="replace-all" />
              </button>
            </div>
          )}
        </div>
      </div>
      <button type="button" className="sv-details-toggle" aria-label={SV.withKey(SV.toggleDetails, "⇧⌘J")} title={SV.withKey(SV.toggleDetails, "⇧⌘J")} aria-pressed={view.details} onClick={() => updateSearchView({ details: !view.details })}>
        <Codicon name="ellipsis" />
      </button>
    </div>
  );
}

function widgetKey(event: KeyboardEvent, toggle: (patch: Partial<SearchViewOptions>) => void, view: SearchViewOptions) {
  const mac = event.metaKey && !event.ctrlKey;
  if (mac && event.altKey && !event.shiftKey) {
    const patch: Record<string, Partial<SearchViewOptions>> = { KeyC: { matchCase: !view.matchCase }, KeyW: { wholeWord: !view.wholeWord }, KeyR: { regex: !view.regex }, KeyP: { preserveCase: !view.preserveCase } };
    const hit = patch[event.code];
    if (hit) {
      event.preventDefault();
      event.stopPropagation();
      if ("preserveCase" in hit) updateSearchView(hit);
      else toggle(hit);
      return;
    }
    if (event.key === "Enter" && view.showReplace) {
      event.preventDefault();
      event.stopPropagation();
      void replaceAll();
    }
  }
  if (mac && event.shiftKey && !event.altKey && event.code === "KeyJ") {
    event.preventDefault();
    event.stopPropagation();
    updateSearchView({ details: !view.details });
  }
}

type InputBoxProps = {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  placeholder: string;
  label: string;
  history: HistoryKind;
  error: string | null;
  onChange: (value: string) => void;
  onHistory: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onTab: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocusResults: () => void;
  children?: ReactNode;
};

function InputBox({ inputRef, value, placeholder, label, history, error, onChange, onHistory, onSubmit, onCancel, onTab, onFocusResults, children }: InputBoxProps) {
  useGrow(inputRef, value);
  const navigator = historyOf(history);
  const showHint = navigator.hasAny() && value === "";
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      if (event.ctrlKey) {
        event.preventDefault();
        const next = `${value.slice(0, el.selectionStart)}\n${value.slice(el.selectionEnd)}`;
        onChange(next);
        requestAnimationFrame(() => el.setSelectionRange(el.selectionStart + 1, el.selectionStart + 1));
        return;
      }
      if (event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Tab") {
      onTab(event);
      return;
    }
    if (event.key === "ArrowDown" && event.metaKey && !event.altKey) {
      event.preventDefault();
      onFocusResults();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const up = event.key === "ArrowUp";
      const multiline = value.includes("\n") || el.scrollHeight > el.clientHeight + 1;
      const atEdge = up ? el.selectionStart === 0 || !value.slice(0, el.selectionStart).includes("\n") : el.selectionEnd === value.length || !value.slice(el.selectionEnd).includes("\n");
      if (event.altKey || !multiline || atEdge) {
        const found = up ? navigator.previous(value) : navigator.next();
        if (found !== null) {
          event.preventDefault();
          onHistory(found);
        } else if (!multiline) event.preventDefault();
      }
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const at = event.key === "PageUp" ? 0 : value.length;
      el.setSelectionRange(at, at);
    }
  };
  return (
    <div className="sv-input" data-invalid={error !== null || undefined}>
      <div className="sv-input-frame">
        <textarea
          ref={inputRef}
          className="sv-input-text"
          rows={1}
          spellCheck={false}
          placeholder={showHint ? `${placeholder}${placeholder.endsWith(")") ? SV.historyHintParen : SV.historyHint}` : placeholder}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={key}
        />
        <div className="sv-input-toggles">{children}</div>
      </div>
      {error !== null && (
        <div className="sv-input-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  if (el.scrollHeight === 0) {
    el.style.height = "";
    return;
  }
  el.style.height = `${el.scrollHeight}px`;
}

function useGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useEffect(() => {
    const el = ref.current;
    if (el) fitHeight(el);
  }, [ref, value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}

function focusResults(listRef: RefObject<HTMLDivElement | null>) {
  listRef.current?.focus();
  revealCursor();
}

function Toggle({ label, keys, icon, on, onChange }: { label: string; keys: string; icon: string; on: boolean; onChange: (on: boolean) => void }) {
  const title = SV.withKey(label, keys);
  return (
    <button type="button" className="sv-toggle" role="checkbox" aria-checked={on} aria-label={title} title={title} data-checked={on || undefined} onClick={() => onChange(!on)}>
      <Codicon name={icon} />
    </button>
  );
}

function SearchDetails({ view }: { view: SearchViewOptions }) {
  const debounce = useSearchUi((s) => s.settings.searchOnTypeDebouncePeriod);
  const onPattern = (kind: "include" | "exclude") => (value: string) => {
    updateSearchView({ [kind]: value });
    scheduleSearchView(debounce);
  };
  const change = (patch: Partial<SearchViewOptions>) => {
    updateSearchView(patch);
    queueMicrotask(() => scheduleSearchView(0));
  };
  return (
    <div className="sv-details">
      <h4 className="sv-details-label">{SV.filesToInclude}</h4>
      <PatternBox kind="include" value={view.openOnly || view.changedOnly ? "" : view.include} disabled={view.openOnly || view.changedOnly} placeholder={SV.placeholderInclude} onChange={onPattern("include")}>
        <Toggle label={SV.onlyChangedFiles} keys="" icon="edit-code" on={view.changedOnly} onChange={(on) => change({ changedOnly: on, openOnly: on ? false : view.openOnly })} />
        <Toggle label={SV.onlyOpenEditors} keys="" icon="book" on={view.openOnly} onChange={(on) => change({ openOnly: on, changedOnly: on ? false : view.changedOnly })} />
      </PatternBox>
      <h4 className="sv-details-label">{SV.filesToExclude}</h4>
      <PatternBox kind="exclude" value={view.exclude} disabled={false} placeholder="" onChange={onPattern("exclude")}>
        <Toggle label={SV.useExcludeSettings} keys="" icon="exclude" on={view.ignore} onChange={(on) => change({ ignore: on })} />
      </PatternBox>
    </div>
  );
}

function PatternBox({ kind, value, disabled, placeholder, onChange, children }: { kind: "include" | "exclude"; value: string; disabled: boolean; placeholder: string; onChange: (value: string) => void; children: ReactNode }) {
  const navigator = historyOf(kind);
  const ref = useRef<HTMLInputElement>(null);
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      addToHistory(kind, value);
      void runSearchView();
    } else if (event.key === "Escape") {
      cancelSearchView();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const found = event.key === "ArrowUp" ? navigator.previous(value) : navigator.next();
      if (found !== null) {
        event.preventDefault();
        onChange(found);
      }
    }
  };
  return (
    <div className="sv-input">
      <div className="sv-input-frame">
        <input ref={ref} className="sv-input-text sv-pattern" spellCheck={false} placeholder={placeholder} aria-label={kind === "include" ? SV.filesToInclude : SV.filesToExclude} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={key} />
        <div className="sv-input-toggles">{children}</div>
      </div>
    </div>
  );
}

function SearchMessage({ view, run, stale, noFolder }: { view: SearchViewOptions; run: SearchRun; stale: boolean; noFolder: boolean }) {
  const model = useSearchUiModel();
  const note = useSearchUi((s) => s.note);
  const canceled = useSearchUi((s) => s.canceled);
  const limitHit = useSearchUi((s) => s.limitHit);
  const phase = useSearchUi((s) => s.phase);
  const searchedOpenOnly = view.openOnly;
  if (noFolder) return <div className="sv-messages"><div className="sv-message">{S.searchNeedsFolder}</div></div>;
  if (note !== null) {
    return (
      <div className="sv-messages">
        <div className="sv-message">
          {note}
          {note === SV.conflict && (
            <>
              {" - "}
              <Link onClick={searchAgain}>{SV.searchAgain}</Link>
            </>
          )}
        </div>
      </div>
    );
  }
  if (canceled) {
    return (
      <div className="sv-messages">
        <div className="sv-message">
          {SV.canceled}
          <Link onClick={() => void runSearchView()}>{SV.searchAgain}</Link>
        </div>
      </div>
    );
  }
  if (run.kind === "error") return <div className="sv-messages"><div className="sv-message" data-kind="error">{run.message}</div></div>;
  if (stale) {
    return (
      <div className="sv-messages">
        <div className="sv-message">
          <Link onClick={() => void runSearchView()}>{S.searchRunSearch}</Link>
        </div>
      </div>
    );
  }
  if (run.kind === "busy") return <div className="sv-messages"><div className="sv-message">{S.searchRunning}</div></div>;
  if (run.kind !== "done" || phase !== 0) return <div className="sv-messages" />;
  if (model.hitCount === 0) {
    const narrowed = view.include.trim() !== "" || view.exclude.trim() !== "";
    return (
      <div className="sv-messages">
        <div className="sv-message" data-kind="empty">
          {noResults(searchedOpenOnly ? "openEditors" : "all", searchedOpenOnly ? "" : view.include.trim(), view.exclude.trim())}
          {narrowed && !searchedOpenOnly ? <Link onClick={() => searchAllFiles()}>{SV.searchAgainInAllFiles}</Link> : <Link onClick={() => setState({ overlay: { kind: "status" } })}>{SV.openSettings}</Link>}
        </div>
      </div>
    );
  }
  return (
    <div className="sv-messages">
      <div className="sv-message">
        {resultCount(model.hitCount, model.fileCount)}
        {!view.ignore && (
          <>
            {` - ${SV.exclusionsDisabled} (`}
            <Link title={SV.useExcludeSettings} onClick={() => reRun({ ignore: true })}>
              {SV.enable}
            </Link>
            {")"}
          </>
        )}
        {view.openOnly && (
          <>
            {` - ${SV.searchingOnlyOpen} (`}
            <Link title={SV.searchInAllFiles} onClick={() => reRun({ openOnly: false })}>
              {SV.disable}
            </Link>
            {")"}
          </>
        )}
        {" - "}
        <Link title={SV.openInEditorTip} onClick={openSearchInEditor}>
          {SV.openInEditor}
        </Link>
      </div>
      {limitHit && <div className="sv-message" data-kind="warning">{SV.limitHit}</div>}
    </div>
  );
}

function reRun(patch: Partial<SearchViewOptions>) {
  updateSearchView(patch);
  queueMicrotask(() => scheduleSearchView(0));
}

function searchAllFiles() {
  reRun({ include: "", exclude: "", openOnly: false, changedOnly: false });
}

function Link({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button type="button" className="sv-link" title={title} tabIndex={-1} onClick={onClick}>
      {children}
    </button>
  );
}

function useFocusRequest(request: number | null, inputRef: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    if (request === null) return;
    let frames = 0;
    let frame = 0;
    const tryFocus = () => {
      const input = inputRef.current;
      if (input && input.offsetParent !== null) {
        input.focus();
        input.select();
        setState({ focusSearchInput: null });
        return;
      }
      if (++frames < 12) frame = requestAnimationFrame(tryFocus);
      else setState({ focusSearchInput: null });
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [request, inputRef]);
}
