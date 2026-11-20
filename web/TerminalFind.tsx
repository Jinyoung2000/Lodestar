import type { ISearchOptions, ISearchResultChangeEvent, SearchAddon } from "@xterm/addon-search";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Codicon } from "./icons";
import { S } from "./strings";

export type TerminalFindProps = { search: SearchAddon; initial: string; options: () => ISearchOptions; onClose: () => void };

export function TerminalFind({ search, initial, options, onClose }: TerminalFindProps) {
  const [term, setTerm] = useState(initial);
  const [result, setResult] = useState<ISearchResultChangeEvent | null>(null);

  useEffect(() => {
    const subscription = search.onDidChangeResults(setResult);
    if (initial) search.findNext(initial, { ...options(), incremental: true });
    return () => {
      subscription.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const find = (forward: boolean, incremental = false) => {
    if (!term) return;
    const searchOptions = { ...options(), incremental };
    if (forward) search.findNext(term, searchOptions);
    else search.findPrevious(term, searchOptions);
  };

  const onInput = (value: string) => {
    setTerm(value);
    if (value) search.findNext(value, { ...options(), incremental: true });
    else {
      search.clearDecorations();
      setResult(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      find(!event.shiftKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const empty = term !== "" && result !== null && result.resultCount === 0;
  const count = term && result && result.resultCount > 0 ? S.findCount(result.resultIndex + 1, result.resultCount) : S.findNoResults;
  const disabled = !term || result?.resultCount === 0;
  return (
    <div className="cm-find terminal-find" role="dialog" aria-label={S.terminalFindAria} data-empty-result={empty || undefined}>
      <div className="cm-find-field">
        <input className="cm-find-input" aria-label={S.findPlaceholder} placeholder={S.findPlaceholder} value={term} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => onInput(e.target.value)} onKeyDown={onKeyDown} />
      </div>
      <div className="cm-find-actions">
        <div className="cm-find-count" aria-live="polite">
          {count}
        </div>
        <button type="button" className="cm-find-button" aria-label={S.findPrevious} title={S.terminalFindPreviousTip} aria-disabled={disabled || undefined} onClick={() => find(false)}>
          <Codicon name="arrow-up" />
        </button>
        <button type="button" className="cm-find-button" aria-label={S.findNext} title={S.terminalFindNextTip} aria-disabled={disabled || undefined} onClick={() => find(true)}>
          <Codicon name="arrow-down" />
        </button>
      </div>
      <button type="button" className="cm-find-button cm-find-close" aria-label={S.findClose} title={S.terminalFindCloseTip} onClick={onClose}>
        <Codicon name="close" />
      </button>
    </div>
  );
}
