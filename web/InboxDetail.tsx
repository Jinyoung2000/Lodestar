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

function byTs(a: InboxThreadMessage, b: InboxThreadMessage) {
  const [as = "0", am = "0"] = a.ts.split(".");
  const [bs = "0", bm = "0"] = b.ts.split(".");
  return Number(as) - Number(bs) || Number(am) - Number(bm);
}

function messageTime(date: Date) {
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

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
