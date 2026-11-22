import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { buildPattern, stepIndex } from "./chatFindModel";
import { clearPaint, collectBlocks, findRanges, firstVisibleIndex, paint, reveal } from "./chatFindDom";
import { closeChatFind, setChatFindQuery, toggleChatFindOption, useChatFind } from "./chatFindState";
import { CF } from "./fileViewStrings";
import "./find.css";
import "./fileView.css";

type Result = { total: number; index: number; capped: boolean; error: string | null };
const NO_RESULT: Result = { total: 0, index: -1, capped: false, error: null };

export function ChatFind({ paneId, scrollRef }: { paneId: string; scrollRef: RefObject<HTMLDivElement | null> }) {
  const find = useChatFind();
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const indexRef = useRef(-1);
  const [result, setResult] = useState<Result>(NO_RESULT);
  const { query, options } = find;

  useLayoutEffect(() => {
    if (find.paneId !== paneId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.nonce, find.paneId, paneId]);

  const search = useCallback(
    (restart: boolean, doReveal: boolean) => {
      const root = scrollRef.current;
      const { regex, error } = buildPattern(query, options);
      if (!root || !regex) {
        rangesRef.current = [];
        indexRef.current = -1;
        clearPaint();
        setResult({ ...NO_RESULT, error });
        return;
      }
      const { ranges, capped } = findRanges(collectBlocks(root), regex);
      rangesRef.current = ranges;
      indexRef.current = ranges.length === 0 ? -1 : restart || indexRef.current < 0 ? firstVisibleIndex(ranges, root) : Math.min(indexRef.current, ranges.length - 1);
      paint(ranges, indexRef.current);
      if (doReveal && indexRef.current >= 0) reveal(root, ranges[indexRef.current]);
      setResult({ total: ranges.length, index: indexRef.current, capped, error: null });
    },
    [query, options, scrollRef],
  );

  useEffect(() => {
    search(true, true);
  }, [search]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => search(false, false), 150);
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [search, scrollRef]);

  useEffect(() => clearPaint, []);

  const go = (backwards: boolean) => {
    const root = scrollRef.current;
    const ranges = rangesRef.current;
    if (!root || !ranges.length) return;
    indexRef.current = stepIndex(indexRef.current, ranges.length, backwards);
    paint(ranges, indexRef.current);
    reveal(root, ranges[indexRef.current]);
    setResult((before) => ({ ...before, index: indexRef.current }));
  };

  const close = () => {
    closeChatFind();
    scrollRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      go(event.shiftKey);
    } else if (event.altKey && event.metaKey && (event.code === "KeyC" || event.code === "KeyW" || event.code === "KeyR")) {
      event.preventDefault();
      toggleChatFindOption(event.code === "KeyC" ? "caseSensitive" : event.code === "KeyW" ? "wholeWord" : "regexp");
    }
    if (!(event.metaKey && event.code === "KeyF")) event.stopPropagation();
  };

  const empty = query.length > 0 && result.total === 0;
  const label = result.error ? "" : !query ? "" : result.total === 0 ? CF.noResults : CF.count(result.index + 1, result.total, result.capped);

  return (
    <div className="cm-find" data-chat="" role="dialog" aria-label={CF.aria} data-empty-result={empty || undefined} onKeyDown={onKeyDown}>
      <div className="cm-find-field" style={{ "--toggles": 3 } as React.CSSProperties} data-invalid={result.error ? "" : undefined}>
        <input
          ref={inputRef}
          className="cm-find-input"
          type="text"
          placeholder={CF.find}
          aria-label={CF.find}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          value={query}
          onChange={(event) => setChatFindQuery(event.target.value)}
        />
        <div className="cm-find-toggles">
          <Toggle icon="case-sensitive" label={CF.caseSensitive} on={options.caseSensitive} onClick={() => toggleChatFindOption("caseSensitive")} />
          <Toggle icon="whole-word" label={CF.wholeWord} on={options.wholeWord} onClick={() => toggleChatFindOption("wholeWord")} />
          <Toggle icon="regex" label={CF.regexp} on={options.regexp} onClick={() => toggleChatFindOption("regexp")} />
        </div>
        {result.error && (
          <div className="cm-find-message" role="alert">
            {result.error}
          </div>
        )}
      </div>
      <div className="cm-find-actions">
        <div className="cm-find-count" aria-live="polite" data-testid="chat-find-count">
          {label}
        </div>
        <IconButton icon="arrow-up" label={CF.previous} disabled={result.total === 0} onClick={() => go(true)} />
        <IconButton icon="arrow-down" label={CF.next} disabled={result.total === 0} onClick={() => go(false)} />
      </div>
      <IconButton icon="close" label={CF.close} className="cm-find-close" onClick={close} />
    </div>
  );
}

function Toggle({ icon, label, on, onClick }: { icon: string; label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="cm-find-toggle" role="checkbox" aria-checked={on} aria-label={label} title={label} onClick={onClick}>
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
    </button>
  );
}

function IconButton({ icon, label, className, disabled, onClick }: { icon: string; label: string; className?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`cm-find-button${className ? ` ${className}` : ""}`} aria-label={label} title={label} aria-disabled={disabled || undefined} onClick={() => !disabled && onClick()}>
      <span className={`codicon codicon-${icon}`} aria-hidden="true" />
    </button>
  );
}
