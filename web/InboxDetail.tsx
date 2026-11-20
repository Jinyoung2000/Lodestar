import { useMemo, useState } from "react";
import { appLink, cleanSlackText, threadMessageLink } from "../shared/inbox";
import type { InboxItem, InboxThreadMessage } from "../shared/protocol";
import { MentionActions, MentionChips, shortTime, useMentionStatus } from "./Inbox";
import { Chat, Check, ChevronDown, ChevronUp, LinkIcon, OpenExternal, Refresh, Start, Trash } from "./icons";
import { rpc } from "./rpc";
import { flash, reanalyzeMention, startInboxSession, useStore } from "./store";
import { S } from "./strings";
import { Button } from "./ui/button";
import { hint } from "./hint";

// Slack 화면의 오른쪽 상세 칸. 메시지 본문, 스레드(눌러야 Slack 에서 읽어 오고, 읽은 뒤에는 펼치고 접는다), 링크(https 와 slack:// 둘 다, 복사 버튼), Start Session, Add to Board, 읽음과 보관.
export function InboxDetail() {
  const id = useStore((s) => s.selectedInboxId);
  const item = useStore((s) => s.inbox?.items.find((i) => i.id === id));
  if (!item) return <div className="empty-hint">{id ? S.inboxNoItem : S.inboxPickItem}</div>;
  return <InboxForm key={item.id} item={item} />;
}

function InboxForm({ item }: { item: InboxItem }) {
  const { board, card, status } = useMentionStatus(item);
  const teamId = useStore((s) => s.settings?.slackTeamId ?? "");
  const app = appLink(item, teamId);
  const fail = (error: Error) => flash(S.inboxFailed(error.message));

  return (
    <div className="card-detail" aria-label={S.inboxDetailAria}>
      <div className="card-detail-body">
        <div className="inbox-detail-head">
          <span className="card-title" data-sensitive>
            {S.inboxFrom(item.from.name, item.channelName)}
          </span>
          <span className="faint xs inbox-detail-meta" title={new Date(item.time).toLocaleString()}>
            {item.kind === "thread" && <span className="label-chip">{S.inboxKind.thread}</span>}
            <MentionChips item={item} status={status} />
            {shortTime(item.time)}
          </span>
        </div>

        {item.judgment && !item.judgment.skipped && (
          <div className="card-detail-section">
            <div className="section-label">{S.mentionSummary}</div>
            <div className="inbox-text" data-sensitive>
              {item.judgment.title}
              {item.judgment.summary ? `\n${item.judgment.summary}` : ""}
            </div>
          </div>
        )}

        <div className="card-detail-section">
          <div className="section-label">{S.inboxMessage}</div>
          <div className="inbox-text" data-sensitive>
            {cleanSlackText(item.text)}
          </div>
        </div>

        <ThreadSection item={item} />

        {item.analysis && (
          <div className="card-detail-section">
            <div className="section-label">{S.analysisSection}</div>
            <div className="muted small">
              {S.analysisStatus[item.analysis.status]}
              {item.analysis.model ? ` (${item.analysis.model}${item.analysis.turns != null ? `, ${item.analysis.turns} turns` : ""}${item.analysis.costUsd != null ? `, $${item.analysis.costUsd.toFixed(3)}` : ""})` : ""}
            </div>
            {item.analysis.error && <div className="inbox-error small">{item.analysis.error}</div>}
            {item.analysis.tools && item.analysis.tools.length > 0 && <div className="faint xs mono">{S.analysisTools(item.analysis.tools.join(", "))}</div>}
          </div>
        )}

        <div className="card-detail-section">
          <div className="section-label">{S.inboxLinks}</div>
          <LinkRow label={S.inboxHttpsLink} url={item.permalink} href={item.permalink} />
          {app ? <LinkRow label={S.inboxAppLink} url={app} href={app} /> : <div className="muted small">{S.inboxAppLinkNeedsTeam}</div>}
        </div>

        <div className="card-detail-actions">
          <Button variant="primary" size="sm" onClick={() => startInboxSession(item)}>
            <Start size={14} /> {S.inboxStartSession}
          </Button>
          <MentionActions item={item} card={card} status={status} board={board} />
          {item.kind === "mention" && status !== "queued" && status !== "analyzing" && (
            <Button size="sm" title={S.reanalyzeTip} onClick={() => void reanalyzeMention(item.id)}>
              <Refresh size={14} /> {S.reanalyze}
            </Button>
          )}
          <Button size="sm" onClick={() => void rpc.call("inbox.markRead", { ids: [item.id], read: !item.read }).catch(fail)}>
            <Check size={14} /> {item.read ? S.inboxMarkUnread : S.inboxMarkRead}
          </Button>
          <Button size="sm" onClick={() => void rpc.call("inbox.archive", { ids: [item.id], archived: !item.archived }).catch(fail)}>
            <Trash size={14} /> {item.archived ? S.inboxUnarchive : S.inboxArchive}
          </Button>
        </div>
      </div>
    </div>
  );
}

// 스레드 전체를 원문 순서(오래된 것부터)로 펼쳐 보이는 구역. 읽기 전에는 버튼 하나이고, 누르면 Slack 에서 한 번 읽어 와 저장한 뒤 펼친다 (읽을 때마다 CLI 세션 하나).
// 읽은 뒤에는 접고 펼치는 것은 화면 안에서만 하고, 새 답글이 궁금하면 다시 읽기 버튼을 누른다.
function ThreadSection({ item }: { item: InboxItem }) {
  const [open, setOpen] = useState(!!item.thread);
  const [loading, setLoading] = useState(false);
  const messages = useMemo(() => [...(item.thread?.messages ?? [])].sort(byTs), [item.thread]);

  const read = async () => {
    setLoading(true);
    try {
      await rpc.call("inbox.thread", { id: item.id });
      setOpen(true);
    } catch (error) {
      flash(S.inboxThreadFailed((error as Error).message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card-detail-section" data-testid="inbox-thread">
      <div className="card-detail-section-head">
        <div className="section-label">
          {S.inboxThread}
          {item.thread && <span className="faint xs inbox-thread-count">{S.inboxThreadCount(messages.length)}</span>}
        </div>
        {item.thread && (
          <Button size="icon" aria-label={S.inboxRefreshThread} title={S.inboxRefreshThread} disabled={loading} onClick={() => void read()}>
            <span className={loading ? "spin" : undefined}>
              <Refresh size={14} />
            </span>
          </Button>
        )}
        {item.thread && (
          <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {open ? S.inboxHideThread : S.inboxShowThread}
          </Button>
        )}
        {!item.thread && (
          <Button size="sm" disabled={loading} onClick={() => void read()}>
            <Chat size={14} /> {loading ? S.inboxThreadLoading : S.inboxShowThread}
          </Button>
        )}
      </div>
      {item.thread && open && messages.every((m) => m.ts === item.ts) && <div className="muted small">{S.inboxThreadEmpty}</div>}
      {item.thread && open && (
        <div className="inbox-thread" role="list">
          {messages.map((m) => (
            <ThreadMessage key={m.ts} item={item} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}

// 스레드 메시지 하나: 보낸 사람, 시각, 이 항목 표시, Slack 에서 열기. 열기는 https 링크이고, 누르면 앱이 설정(Open Slack links in)에 따라 Slack 앱이나 브라우저로 보낸다.
function ThreadMessage({ item, message }: { item: InboxItem; message: InboxThreadMessage }) {
  const link = threadMessageLink(item, message.ts);
  const here = message.ts === item.ts;
  const at = new Date(parseFloat(message.ts) * 1000);
  return (
    <div role="listitem" className="inbox-thread-message" data-current={here || undefined}>
      <div className="inbox-thread-head">
        <span className="inbox-from" data-sensitive>
          {message.from.name}
        </span>
        {here && <span className="label-chip">{S.inboxThreadHere}</span>}
        <span className="faint xs" title={at.toLocaleString()}>
          {messageTime(at)}
        </span>
        <span className="spacer" />
        {link && (
          <Button asChild size="icon" variant="ghost">
            <a href={link} target="_blank" rel="noreferrer noopener" aria-label={S.inboxThreadOpenMessage} title={S.inboxThreadOpenMessage}>
              <OpenExternal size={14} />
            </a>
          </Button>
        )}
      </div>
      <div className="inbox-text" data-sensitive>
        {cleanSlackText(message.text)}
      </div>
    </div>
  );
}

// ts 는 "초.마이크로초" 문자열이다. 소수 부분까지 정수로 나눠 비교한다 (실수로 바꾸면 마이크로초가 뭉개질 수 있다).
function byTs(a: InboxThreadMessage, b: InboxThreadMessage) {
  const [as = "0", am = "0"] = a.ts.split(".");
  const [bs = "0", bm = "0"] = b.ts.split(".");
  return Number(as) - Number(bs) || Number(am) - Number(bm);
}

// 같은 날이면 시각만, 아니면 날짜와 시각.
function messageTime(date: Date) {
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

// 링크는 사용자가 누를 때만 열린다. slack:// 은 환경에 따라 안 열릴 수 있어서 복사 버튼이 같이 있다.
function LinkRow({ label, url, href }: { label: string; url: string; href: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      hint(S.inboxCopied, undefined, { check: true });
    } catch {
      flash(S.inboxFailed("clipboard is not available"));
    }
  };
  return (
    <div className="card-detail-row">
      <a className="card-link" href={href} target="_blank" rel="noreferrer noopener" title={label}>
        <OpenExternal size={14} />
        <span className="mono truncate" data-sensitive>
          {url}
        </span>
      </a>
      <Button size="icon" aria-label={`${S.inboxCopy} ${label}`} title={`${S.inboxCopy} ${label}`} onClick={() => void copy()}>
        <LinkIcon size={14} />
      </Button>
    </div>
  );
}
