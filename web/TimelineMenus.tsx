import { memo, useEffect, useState, type RefObject } from "react";
import { harnessOf, type Agent, type TimelineItem } from "../shared/protocol";
import { Codicon } from "./icons";
import { addAttachment, flash, getState, openSide, setState, startDraft, topWorkspaceId } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { hint } from "./hint";

type Anchor = { x: number; y: number; text: string };
type BarAnchor = Anchor & { commenting?: boolean };

export const TimelineMenus = memo(function TimelineMenus({ containerRef, agent, paneId }: { containerRef: RefObject<HTMLDivElement | null>; agent: Agent; paneId: string }) {
  const items = (): TimelineItem[] => getState().timelines[agent.id] ?? [];
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [bar, setBar] = useState<BarAnchor | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onContext = (event: MouseEvent) => {
      event.preventDefault();
      setBar(null);
      setMenu({ x: event.clientX, y: event.clientY, text: selectedText(el) });
    };
    const onUp = () =>
      window.setTimeout(() => {
        const text = selectedText(el);
        const range = text ? window.getSelection()?.getRangeAt(0) : null;
        if (!range) return setBar(null);
        const rect = range.getBoundingClientRect();
        setBar({ x: Math.min(rect.left, window.innerWidth - 400), y: rect.bottom + 6, text });
      }, 0);
    const clear = () => setBar(null);
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("mouseup", onUp);
    el.addEventListener("mousedown", clear);
    el.addEventListener("scroll", clear);
    return () => {
      el.removeEventListener("contextmenu", onContext);
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("mousedown", clear);
      el.removeEventListener("scroll", clear);
    };
  }, [containerRef]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => hint(S.copied, undefined, { check: true }), () => flash(S.mcpCopyFailed));
  };
  const quote = (text: string) => {
    const draft = (document.getElementById(`composer-${paneId}`) as HTMLTextAreaElement | null)?.value ?? "";
    const quoted = text.trim().split("\n").map((line) => `> ${line}`).join("\n");
    setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text: `${quoted}\n\n${draft}`, nonce: Date.now() } }, focusComposer: { paneId, nonce: Date.now() } }));
  };
  useEffect(() => {
    if (!bar || bar.commenting) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.code !== "Quote") return;
      event.preventDefault();
      quote(bar.text);
      setBar(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bar]);
  const addComment = (text: string, comment: string) => {
    if (!comment.trim()) return;
    addAttachment(paneId, { workspaceId: null, path: "", startLine: null, endLine: null, text, quote: { comment: comment.trim() } });
    window.getSelection()?.removeAllRanges();
    setBar(null);
  };
  const newChat = () => startDraft(topWorkspaceId(agent.workspaceId) ?? agent.workspaceId);

  return (
    <>
      <DropdownMenu open={!!menu} onOpenChange={(open) => !open && setMenu(null)} modal={false}>
        <DropdownMenuTrigger asChild>
          <span className="context-anchor" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={0} className="session-menu" data-menu="chat">
          <DropdownMenuItem disabled={!menu?.text} onSelect={() => menu && copy(menu.text)}>
            <span>{S.copyResponse}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copy(conversationText(items()))}>
            <span>{S.copyAll}</span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!menu || !finalResponse(items())} onSelect={() => copy(finalResponse(items()))}>
            <span>{S.copyFinalResponse}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={newChat}>
            <span>{S.newChat}</span>
            <span className="faint xs menu-hint">⌘N</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {bar?.commenting && (
        <form
          className="selection-bar selection-comment"
          aria-label={S.quoteComment}
          style={{ left: bar.x, top: bar.y }}
          onSubmit={(event) => {
            event.preventDefault();
            addComment(bar.text, String(new FormData(event.currentTarget).get("comment") ?? ""));
          }}
        >
          <textarea
            name="comment"
            className="selection-comment-input"
            aria-label={S.quoteCommentPlaceholder}
            placeholder={S.quoteCommentPlaceholder}
            rows={1}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setBar(null);
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit">{S.quoteCommentAdd}</button>
        </form>
      )}
      {bar && !bar.commenting && (
        <div className="selection-bar" role="toolbar" aria-label={S.selectionToolbarAria} style={{ left: bar.x, top: bar.y }} onMouseDown={(event) => event.preventDefault()}>
          {harnessOf(agent) === "claude" && (
            <button
              type="button"
              onClick={() => {
                openSide(agent.id, bar.text);
                setBar(null);
              }}
            >
              <Codicon name="comment-discussion" size={14} />
              {S.askInSideChat}
            </button>
          )}
          <button type="button" title={S.quoteCommentTip} onClick={() => setBar({ ...bar, commenting: true })}>
            <Codicon name="comment" size={14} />
            {S.quoteComment}
          </button>
          <button
            type="button"
            title={S.quoteTip}
            onClick={() => {
              quote(bar.text);
              setBar(null);
            }}
          >
            <Codicon name="quote" size={14} />
            {S.quote}
            <span className="faint xs">{S.quoteKey}</span>
          </button>
        </div>
      )}
    </>
  );
});

function selectedText(container: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  return container.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString().trim() : "";
}

function finalResponse(items: TimelineItem[]) {
  const last = items.findLast((i) => i.kind === "assistant" && !i.streaming);
  return last?.kind === "assistant" ? last.text : "";
}

function conversationText(items: TimelineItem[]) {
  return items
    .filter((i) => (i.kind === "user" && i.source !== "system") || (i.kind === "assistant" && !i.streaming))
    .map((i) => (i.kind === "user" ? (i.shown ?? i.text) : i.kind === "assistant" ? i.text : ""))
    .join("\n\n");
}
