import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Board, BoardCard, InboxItem } from "../shared/protocol";
import { cleanSlackText, mentionStatus, type MentionStatus } from "../shared/inbox";
import { SLACK_NOT_CONNECTED_PREFIX, SLACK_SERVER_NAME } from "../shared/mcp";
import { Check, Refresh } from "./icons";
import { InboxDetail } from "./InboxDetail";
import { inboxKindCounts, inboxRows, matchesKind, matchesShow, neighborRowId, type InboxKindFilter, type InboxShow } from "./inboxRows";
import { McpDetail } from "./McpPanel";
import { rpc } from "./rpc";
import { SplitDetail } from "./SplitDetail";
import { addInboxItemToBoard, closeInboxItem, flash, markNotRequest, openCard, openInboxItem, reconnectMcp, refreshInbox, setState, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

// 가운데 영역에 세션 격자 대신 보이는 Slack 화면. 사용자를 멘션한 메시지와 사용자가 참여한 스레드의 새 답글을 최신순으로 보이고(종류 탭: All, Mentions, Threads),
// 항목을 누르면 이 화면 안의 오른쪽 상세 칸에 열린다(세션 오른쪽 패널은 쓰지 않는다).
// 요청으로 판단된 멘션은 분석(대기, 분석 중, 완료, 실패)을 거쳐 보드 카드가 되고, 목록 줄에 그 상태와 카드로 가는 버튼이 있다.
// 보낸 사람, 채널, 본문 노드에는 data-sensitive 를 달아 두었다 (화면 검증 때 이 속성으로 가린다).
type Show = InboxShow;
const KIND_TABS: InboxKindFilter[] = ["all", "mention", "thread"];

export function InboxView() {
  const inbox = useStore((s) => s.inbox);
  const selectedId = useStore((s) => s.selectedInboxId);
  const [show, setShow] = useState<Show>("unread");
  const [kind, setKind] = useState<InboxKindFilter>("all");
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);

  // 열린 항목은 필터와 맞지 않게 되어도(열면서 읽음 처리) 고른 동안 목록에 남는다.
  const rows = useMemo(() => inboxRows(inbox?.items ?? [], show, selectedId, kind), [inbox, show, selectedId, kind]);
  const counts = useMemo(() => inboxKindCounts(inbox?.items ?? [], show), [inbox, show]);

  // 필터를 바꿀 때 열린 항목이 새 필터에 안 맞으면 목록에서 빠지므로 상세도 닫는다.
  const changeShow = (next: Show) => {
    setShow(next);
    const open = inbox?.items.find((i) => i.id === selectedId);
    if (open && !(matchesShow(open, next) && matchesKind(open, kind))) closeInboxItem();
  };
  const changeKind = (next: InboxKindFilter) => {
    setKind(next);
    const open = inbox?.items.find((i) => i.id === selectedId);
    if (open && !(matchesShow(open, show) && matchesKind(open, next))) closeInboxItem();
  };

  // 목록에서 ↑ ↓ 를 누르면 다음 항목을 열고 그 행으로 포커스를 옮긴다.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!(event.target as HTMLElement).classList.contains("inbox-row")) return;
    event.preventDefault();
    const next = neighborRowId(rows, selectedId, event.key === "ArrowDown" ? 1 : -1);
    if (!next) return;
    focusAfter.current = next;
    openInboxItem(next);
  };
  // 옛 행이 목록에서 빠지며 포커스를 잃으니, 목록이 바뀐 직후 새로 연 행에 포커스를 되돌린다.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`)?.focus();
  }, [rows]);

  if (!inbox) {
    return (
      <section className="inbox" aria-label={S.inbox}>
        <div className="pane-header">
          <span className="agent-title">{S.inbox}</span>
        </div>
        <div className="empty-hint">{S.inboxUnavailable}</div>
      </section>
    );
  }

  // Mark all read 는 지금 고른 종류 탭의 안 읽은 항목만 읽음으로 바꾼다.
  const unreadIds = inbox.items.filter((i) => !i.read && !i.archived && matchesKind(i, kind)).map((i) => i.id);
  const last = inbox.lastFetch;
  const empty = S.inboxEmptyOf(show, kind);

  return (
    <div className="split-view">
      <section className="inbox" aria-label={S.inbox}>
        <div className="pane-header">
          <span className="agent-title board-header-title">{S.inbox}</span>
          <Select value={show} onValueChange={(v) => changeShow(v as Show)}>
            <SelectTrigger aria-label={S.inboxFilter} title={S.inboxFilter}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unread">{S.inboxShowUnread}</SelectItem>
              <SelectItem value="all">{S.inboxShowAll}</SelectItem>
              <SelectItem value="archived">{S.inboxShowArchived}</SelectItem>
            </SelectContent>
          </Select>
          <span className="spacer" />
          <Button size="sm" aria-label={S.inboxMarkAllRead} title={S.inboxMarkAllRead} disabled={!unreadIds.length} onClick={() => void rpc.call("inbox.markRead", { ids: unreadIds, read: true }).catch((e: Error) => flash(S.inboxFailed(e.message)))}>
            <Check size={14} /> <span className="inbox-markall-label">{S.inboxMarkAllRead}</span>
          </Button>
          <Button size="icon" aria-label={S.inboxRefresh} title={inbox.fetching ? S.inboxRefreshing : S.inboxRefresh} disabled={inbox.fetching} onClick={() => refreshInbox()}>
            <span className={inbox.fetching ? "spin" : undefined}>
              <Refresh size={14} />
            </span>
          </Button>
        </div>
        <div className="inbox-kinds" role="tablist" aria-label={S.inboxKindFilter}>
          {KIND_TABS.map((tab) => (
            <button key={tab} type="button" role="tab" className="inbox-kind" aria-selected={kind === tab} data-kind={tab} onClick={() => changeKind(tab)}>
              {S.inboxKindTab[tab]}
              <span className="inbox-kind-count">{counts[tab]}</span>
            </button>
          ))}
        </div>
        <div className="inbox-status" role="status">
          {inbox.fetching ? S.inboxRefreshing : last ? S.inboxLastFetch(shortTime(last.at), last.added) : S.inboxNever}
          {last?.judge && last.judge.judged > 0 && !inbox.fetching && <span> {S.inboxJudged(last.judge.judged, last.judge.requests, last.judge.queued)}</span>}
          {last?.judge?.error && !inbox.fetching && <span className="inbox-warn"> {S.inboxJudgeFailed(last.judge.error)}</span>}
          {last?.partial && !inbox.fetching && <span className="inbox-warn"> {S.inboxPartial}</span>}
          {last?.error && !inbox.fetching && <span className="inbox-error"> {last.error}</span>}
        </div>
        <SlackConnection />
        <MentionSetupHint />
        <div className="inbox-list" role="list" ref={listRef} onKeyDown={onListKeyDown}>
          {rows.length === 0 && <div className="empty-hint">{empty}</div>}
          {rows.map((item) => (
            <InboxRow key={item.id} item={item} selected={item.id === selectedId} />
          ))}
        </div>
      </section>
      <SplitDetail widthKey="inboxDetailWidth" label={S.inboxDetailAria} title={S.inboxDetail} closeLabel={S.inboxCloseItem} onClose={selectedId ? closeInboxItem : null} compact>
        <InboxDetail />
      </SplitDetail>
    </div>
  );
}

// 처음 쓰는 사람에게 보이는 안내. 자동 수집과 분석은 기본이 꺼져 있고, 켜기 전에 무엇이 비용을 쓰는지 알린다. 한 번이라도 가져오면 사라진다.
function MentionSetupHint() {
  const neverFetched = useStore((s) => s.inbox?.lastFetch == null);
  const off = useStore((s) => !s.settings?.inboxIntervalMinutes || !s.settings?.autoAddRequests);
  if (!neverFetched || !off) return null;
  return (
    <div className="inbox-setup" role="note" data-testid="inbox-setup">
      <div className="inbox-setup-title">{S.inboxSetupTitle}</div>
      <div className="inbox-setup-body">{S.inboxSetupBody}</div>
      <Button size="sm" onClick={() => setState({ overlay: { kind: "status", section: "mentions" } })}>
        {S.inboxSetupOpen}
      </Button>
    </div>
  );
}

// Slack MCP 서버가 연결돼 있지 않으면 가져오기가 실패한다. 상태를 다시 확인하고, 연결되면 곧바로 다시 가져온다.
// 가져오기는 매번 새 CLI 프로세스로 하므로, 로그인을 마쳤다면 이 확인이 연결로 돌아오는 순간 다음 가져오기가 성공한다.
function SlackConnection() {
  const slack = useStore((s) => s.meta?.mcp.find((m) => m.name === SLACK_SERVER_NAME) ?? null);
  const lastError = useStore((s) => s.inbox?.lastFetch?.error ?? null);
  const fetching = useStore((s) => s.inbox?.fetching ?? false);
  const busy = useStore((s) => !!s.mcpBusy[SLACK_SERVER_NAME]);
  // 이 확인에서 꺼 둔(disabled) 서버는 가져오기에 영향이 없다. 가져오기는 매번 설정을 새로 읽는 별도 CLI 프로세스라서다.
  const down = slack !== null && slack.status !== "connected" && slack.status !== "disabled";
  const failedAsDown = lastError?.startsWith(SLACK_NOT_CONNECTED_PREFIX) ?? false;
  if (!down && !failedAsDown) return null;
  const reconnect = async () => {
    const result = await reconnectMcp(SLACK_SERVER_NAME);
    if (result?.ok) refreshInbox();
  };
  return (
    <div className="inbox-mcp" role="status" data-testid="inbox-slack-down">
      <div className="inbox-mcp-row">
        <span className="dot" data-state={busy ? "pending" : (slack?.status ?? "failed")} />
        <span className="grow">{S.inboxSlackDown(slack?.status ?? "not connected")}</span>
        <Button size="sm" disabled={busy || fetching} onClick={() => void reconnect()}>
          <span className={busy ? "spin" : undefined}>
            <Refresh size={14} />
          </span>
          {busy ? S.mcpReconnecting : S.inboxSlackReconnect}
        </Button>
      </div>
      {slack && <McpDetail server={slack} />}
    </div>
  );
}

// 항목의 카드. cardId 의 카드가 있으면 그것, 없으면 같은 Slack 링크를 가진 카드 (이 기능 이전에 수동으로 만든 카드).
export function mentionCardOf(board: Board | null, item: InboxItem): BoardCard | null {
  if (!board) return null;
  return board.cards.find((c) => c.id === item.cardId) ?? (item.permalink ? board.cards.find((c) => c.links.some((l) => l.url === item.permalink)) : undefined) ?? null;
}

export function useMentionStatus(item: InboxItem) {
  const board = useStore((s) => s.board);
  const card = mentionCardOf(board, item);
  return { board, card, status: mentionStatus(item, !!card) };
}

// 상태 칩. 분석이 실패했으면 이유를 툴팁으로 달고 칩을 하나 더 보인다.
export function MentionChips({ item, status }: { item: InboxItem; status: MentionStatus }) {
  const analysis = item.analysis;
  return (
    <>
      {status !== "none" && (
        <span className="label-chip" data-status={status}>
          {S.mentionStatus[status]}
        </span>
      )}
      {analysis?.status === "failed" && (
        <span className="label-chip" data-status="failed" title={S.analysisFailedTip(analysis.error ?? "")}>
          {S.analysisFailed}
        </span>
      )}
    </>
  );
}

// 카드가 있으면 카드 열기와 Not a request, 없으면 Add to Board. 대기 중이거나 분석 중이면 Not a request 로 멈출 수 있다.
export function MentionActions({ item, card, status, board }: { item: InboxItem; card: BoardCard | null; status: MentionStatus; board: Board | null }) {
  const working = status === "queued" || status === "analyzing";
  return (
    <>
      {card && (
        <Button size="sm" onClick={() => openCard(card.id)}>
          {S.openBoardCard}
        </Button>
      )}
      {!card && !working && (
        <Button size="sm" disabled={!board} onClick={() => void addInboxItemToBoard(item)}>
          {S.addToBoard}
        </Button>
      )}
      {(card || working) && (
        <Button size="sm" title={S.notRequestTip} onClick={() => void markNotRequest(item)}>
          {S.notRequest}
        </Button>
      )}
    </>
  );
}

function InboxRow({ item, selected }: { item: InboxItem; selected: boolean }) {
  const { board, card, status } = useMentionStatus(item);
  const firstLine = cleanSlackText(item.text).split("\n").find((l) => l.trim()) ?? "";
  const done = item.analysis?.status === "done" ? item.analysis.stats : undefined;
  return (
    <div role="listitem" className="inbox-item">
      <button type="button" className="inbox-row" data-inbox-id={item.id} data-selected={selected || undefined} data-unread={!item.read || undefined} onClick={() => openInboxItem(item.id)}>
        <span className="inbox-dot" aria-label={item.read ? undefined : "Unread"} />
        <span className="inbox-main">
          <span className="inbox-head">
            <span className="inbox-from" data-sensitive>
              {item.from.name}
            </span>
            <span className="inbox-channel muted" data-sensitive>
              {item.channelName}
            </span>
            <span className="spacer" />
            {item.kind === "thread" && <span className="label-chip">{S.inboxKind.thread}</span>}
            <MentionChips item={item} status={status} />
            <span className="faint xs" title={new Date(item.time).toLocaleString()}>
              {shortTime(item.time)}
            </span>
          </span>
          <span className="inbox-line" data-sensitive>
            {firstLine}
          </span>
        </span>
      </button>
      <div className="inbox-actions">
        <MentionActions item={item} card={card} status={status} board={board} />
        {done && <span className="faint xs">{S.analysisDone(done.steps, done.files, done.questions)}</span>}
      </div>
    </div>
  );
}

export function shortTime(iso: string) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
