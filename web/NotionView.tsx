import DOMPurify from "dompurify";
import { useEffect, useMemo } from "react";
import { notionAppUrl, notionPageKey } from "../shared/notionLink";
import { propertyRows } from "../shared/notionFetch";
import type { NotionPageView } from "../shared/protocol";
import { AgentView } from "./AgentView";
import { hint } from "./hint";
import { Codicon, More, Plus, Refresh } from "./icons";
import { parseMarkdown } from "./markdownParse";
import { openLinkOutside } from "./fileRefs";
import { NotionChatStart } from "./NotionChatStart";
import "./notion.css";
import { openNotionInApp, pinNotionPage, unpinNotionPage, usePinFor } from "./notionStore";
import { chatOfPage, refreshNotionScreen, useNotionScreen } from "./notionScreen";
import { N } from "./notionStrings";
import { SplitDetail } from "./SplitDetail";
import { rpc } from "./rpc";
import { bindVirtualPane } from "./composerState";
import { ensureTimeline, flash, useStore } from "./store";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

// 앱 안 Notion 화면. 왼쪽에 Notion MCP 로 읽은 페이지를 마크다운으로 그리고, 오른쪽에 그 페이지 전용 대화를 붙인다.
// 표나 보드처럼 마크다운으로 못 그리는 화면은 Browser 탭으로 연다(Open in Browser Tab).
export function NotionView() {
  const url = useNotionScreen((s) => s.url);
  const view = useNotionScreen((s) => s.view);
  const loading = useNotionScreen((s) => s.loading);
  const error = useNotionScreen((s) => s.error);
  const agentId = useNotionScreen((s) => chatOfPage(s.chats, s.url));
  const chatExists = useStore((s) => (agentId ? s.agents.some((a) => a.id === agentId) : false));

  if (!url) {
    return (
      <section className="notion-view" aria-label={N.viewAria}>
        <div className="pane-header">
          <span className="agent-title">{N.viewName}</span>
        </div>
        <div className="empty-hint">{N.viewEmpty}</div>
      </section>
    );
  }

  return (
    <div className="split-view notion-split">
      <section className="notion-view" aria-label={N.viewAria}>
        <NotionHeader url={url} view={view} loading={loading} />
        <div className="notion-page-scroll">
          {error && <NotionError message={error} hasView={view !== null} />}
          {view ? <NotionDocument view={view} stale={loading} /> : !error && <div className="notion-loading">{N.loading}</div>}
        </div>
      </section>
      <SplitDetail
        widthKey="notionChatWidth"
        label={N.chatAria}
        title={N.chatTitle}
        closeLabel={N.chatNew}
        onClose={null}
        actions={
          chatExists && (
            <Button size="icon" aria-label={N.chatNew} title={N.chatNew} onClick={() => void rpc.call("notion.chat.reset", { url }).catch((e: Error) => flash(e.message))}>
              <Plus size={14} />
            </Button>
          )
        }
      >
        {agentId && chatExists ? <NotionChat key={agentId} url={url} agentId={agentId} /> : <NotionChatStart key={notionPageKey(url)} url={url} />}
      </SplitDetail>
    </div>
  );
}

function NotionHeader({ url, view, loading }: { url: string; view: NotionPageView | null; loading: boolean }) {
  const page = view?.page ?? null;
  const pin = usePinFor(url);
  const appUrl = notionAppUrl(url);
  return (
    <div className="pane-header notion-head">
      <span className="notion-head-icon" aria-hidden>
        {page?.icon ? <span className="notion-emoji">{page.icon}</span> : <Codicon name={page?.kind === "database" ? "table" : "file"} size={16} />}
      </span>
      <span className="agent-title notion-head-title" title={page?.title ?? url}>
        {page?.title ?? N.viewName}
      </span>
      {page?.path && (
        <span className="notion-head-path" title={page.path}>
          {page.path}
        </span>
      )}
      <span className="spacer" />
      {view && <NotionTimes view={view} />}
      <Button size="icon" aria-label={loading ? N.refreshing : N.refresh} title={loading ? N.refreshing : N.refresh} disabled={loading} onClick={() => refreshNotionScreen()}>
        <span className={loading ? "spin" : undefined}>
          <Refresh size={14} />
        </span>
      </Button>
      <Button size="sm" onClick={() => openNotionInApp(url)}>
        <Codicon name="globe" size={14} />
        <span className="notion-head-label">{N.openInTab}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" aria-label={N.moreActions} title={N.moreActions}>
            <More />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="session-menu" data-menu="notion-view">
          <DropdownMenuItem onSelect={() => openNotionInApp(url)}>{N.openInTab}</DropdownMenuItem>
          <DropdownMenuItem disabled={appUrl === null} onSelect={() => window.open(appUrl ?? url, "_blank", "noopener")}>
            {N.openInNotion}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(url).then(() => hint(N.copied, undefined, { check: true }), () => flash(N.copyLink))}>{N.copyLink}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => (pin ? void unpinNotionPage(pin.id) : void pinNotionPage({ title: page?.title ?? "", url, ...(page?.icon ? { icon: page.icon } : {}), kind: page?.kind === "database" ? "database" : "page" }))}>
            {pin ? N.unpinFromSidebar : N.pinToSidebar}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NotionTimes({ view }: { view: NotionPageView }) {
  const edited = view.page.lastEditedAt;
  return (
    <span className="notion-head-times" title={edited ? `${new Date(edited).toLocaleString()}` : undefined}>
      {edited ? `${N.edited(relativeTime(edited))} · ${N.readAt(relativeTime(view.fetchedAt))}` : N.readAt(relativeTime(view.fetchedAt))}
    </span>
  );
}

function NotionError({ message, hasView }: { message: string; hasView: boolean }) {
  return (
    <div className="notion-error" role="alert">
      <div className="notion-error-title">{N.readFailed}</div>
      <div className="notion-error-text">{message}</div>
      <div className="notion-error-actions">
        {hasView && <span className="faint xs">{N.staleNote}</span>}
        <Button size="sm" onClick={() => refreshNotionScreen()}>
          {N.retry}
        </Button>
      </div>
    </div>
  );
}

function NotionDocument({ view, stale }: { view: NotionPageView; stale: boolean }) {
  const { page } = view;
  const html = useMemo(() => DOMPurify.sanitize(parseMarkdown(page.markdown, { breaks: true })), [page.markdown]);
  const rows = useMemo(() => propertyRows(page.properties), [page.properties]);
  return (
    <article className="notion-doc" data-stale={stale || undefined}>
      <h1 className="notion-doc-title">
        {page.icon && <span className="notion-doc-emoji">{page.icon}</span>}
        {page.title}
      </h1>
      <NotionDocMeta view={view} />
      {rows.length > 0 && (
        <dl className="notion-props" aria-label={N.properties}>
          {rows.map((row) => (
            <div key={row.name} className="notion-prop">
              <dt>{row.name}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {page.needsBrowser && (
        <div className="notion-note-card" role="note">
          <span>{N.needsBrowser}</span>
          <Button size="sm" onClick={() => openNotionInApp(page.url)}>
            {N.openInTab}
          </Button>
        </div>
      )}
      {page.truncated && <div className="notion-note-card">{N.truncated}</div>}
      {page.markdown ? <div className="markdown notion-doc-body" onClick={openLinkOutside} dangerouslySetInnerHTML={{ __html: html }} /> : !page.needsBrowser && <div className="empty-hint">{N.emptyPage}</div>}
    </article>
  );
}

// 제목 아래 한 줄: 상위 경로, 마지막 수정, 읽은 시각. 머리줄이 좁아 접히면 이 줄이 대신 보인다.
function NotionDocMeta({ view }: { view: NotionPageView }) {
  const parts = [view.page.path, view.page.lastEditedAt ? N.edited(relativeTime(view.page.lastEditedAt)) : null, N.readAt(relativeTime(view.fetchedAt))].filter(Boolean);
  return <div className="notion-doc-meta">{parts.join(" · ")}</div>;
}

// 이 페이지에 붙은 대화. 칸 머리 없이 대화와 입력창만 보인다. 승인 카드(Notion 쓰기 diff 포함)는 입력창 위에 뜬다.
function NotionChat({ url, agentId }: { url: string; agentId: string }) {
  const paneId = `notion:${notionPageKey(url)}`;
  const unread = useStore((s) => s.agents.find((a) => a.id === agentId)?.unread ?? false);
  // 칸에 열린 세션이 아니라서 타임라인을 직접 읽어 둔다(읽어 두면 이후 변경은 이벤트로 이어진다)
  useEffect(() => ensureTimeline(agentId), [agentId]);
  useEffect(() => bindVirtualPane(paneId, agentId), [paneId, agentId]);
  useEffect(() => {
    if (unread && document.hasFocus()) void rpc.call("agents.markRead", { agentId, read: true }).catch(() => undefined);
  }, [unread, agentId]);
  return (
    <div className="pane notion-chat-pane" data-active>
      <AgentView paneId={paneId} agentId={agentId} closable={false} embedded />
    </div>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// "3 minutes ago" 같은 짧은 상대 시각
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return "";
  const seconds = Math.round(diff / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return RELATIVE.format(days, "day");
  return new Date(iso).toLocaleDateString();
}

