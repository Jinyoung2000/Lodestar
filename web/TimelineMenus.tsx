import { memo, useEffect, useState, type RefObject } from "react";
import type { Agent, TimelineItem } from "../shared/protocol";
import { Codicon } from "./icons";
import { flash, getState, openSide, setState, startDraft, topWorkspaceId } from "./store";
import { S } from "./strings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { hint } from "./hint";
import { sourcePart } from "../shared/toBoard";
import { canAddToBoard, openToBoard } from "./toBoardState";

type Anchor = { x: number; y: number; text: string };
// itemId: 고른 글이 든 대화 항목(없으면 그 턴의 사용자 메시지). Add to Board 가 카드와 메시지를 잇는 데 쓴다.
type BarAnchor = Anchor & { itemId: string | null };

// 대화 본문 우클릭 메뉴(Copy, Copy All, New Chat)와 글을 고르면 뜨는 작은 도구 막대(Ask in a Side Chat, Quote, Copy). B2-19.
// 대화 항목은 메뉴를 그리거나 누를 때 store 에서 읽는다. props 로 받으면 응답 이벤트마다 닫혀 있는 메뉴(Radix 컴포넌트 20개 남짓)까지 다시 그려졌다(PERF2).
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
    // 선택이 끝난 뒤(mouseup 다음 틱)에 읽어야 브라우저가 선택 범위를 확정해 둔다.
    const onUp = () =>
      window.setTimeout(() => {
        const text = selectedText(el);
        const range = text ? window.getSelection()?.getRangeAt(0) : null;
        if (!range) return setBar(null);
        const rect = range.getBoundingClientRect();
        setBar({ x: Math.min(rect.left, window.innerWidth - 400), y: rect.bottom + 6, text, itemId: itemOf(range.startContainer) });
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
  // 인용은 입력창에 쓰던 글 앞에 붙인다.
  const quote = (text: string) => {
    const draft = (document.getElementById(`composer-${paneId}`) as HTMLTextAreaElement | null)?.value ?? "";
    const quoted = text.trim().split("\n").map((line) => `> ${line}`).join("\n");
    setState((s) => ({ composerPrefill: { ...s.composerPrefill, [paneId]: { text: `${quoted}\n\n${draft}`, nonce: Date.now() } }, focusComposer: { paneId, nonce: Date.now() } }));
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
      {bar && (
        <div className="selection-bar" role="toolbar" aria-label={S.selectionToolbarAria} style={{ left: bar.x, top: bar.y }} onMouseDown={(event) => event.preventDefault()}>
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
          <button
            type="button"
            onClick={() => {
              quote(bar.text);
              setBar(null);
            }}
          >
            <Codicon name="quote" size={14} />
            {S.quote}
          </button>
          <button
            type="button"
            onClick={() => {
              copy(bar.text);
              setBar(null);
            }}
          >
            <Codicon name="copy" size={14} />
            {S.copyResponse}
          </button>
          {bar.itemId && canAddToBoard() && (
            <button
              type="button"
              title={S.toBoardSelectionTip}
              data-action="add-to-board"
              onClick={(event) => {
                const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
                openToBoard({ agentId: agent.id, itemId: bar.itemId!, text: bar.text, part: sourcePart(bar.text), rect: { left, top, right, bottom } });
                setBar(null);
              }}
            >
              <Codicon name="project" size={14} />
              {S.addToBoard}
            </button>
          )}
        </div>
      )}
    </>
  );
});

// 선택이 시작된 곳을 품은 대화 항목 id. 항목 표시가 없는 곳(단계 묶음의 출력 등)이면 그 턴의 사용자 메시지.
function itemOf(node: Node): string | null {
  const el = node instanceof Element ? node : node.parentElement;
  const item = el?.closest("[data-item-id]")?.getAttribute("data-item-id");
  if (item) return item;
  const turn = el?.closest("[data-turn-key]")?.getAttribute("data-turn-key");
  return turn && turn !== "head" ? turn : null;
}

function selectedText(container: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  return container.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString().trim() : "";
}

// 마지막으로 확정된 응답 한 덩어리
function finalResponse(items: TimelineItem[]) {
  const last = items.findLast((i) => i.kind === "assistant" && !i.streaming);
  return last?.kind === "assistant" ? last.text : "";
}

// 사용자 메시지와 확정된 응답을 순서대로 이은 글
function conversationText(items: TimelineItem[]) {
  return items
    .filter((i) => (i.kind === "user" && i.source !== "system") || (i.kind === "assistant" && !i.streaming))
    .map((i) => (i.kind === "user" ? (i.shown ?? i.text) : i.kind === "assistant" ? i.text : ""))
    .join("\n\n");
}
