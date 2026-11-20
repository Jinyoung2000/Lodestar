import { useEffect, useState } from "react";
import { cardKey } from "../shared/board";
import type { BoardCard, BoardPriority, CardPatch, CardSource } from "../shared/protocol";
import { parseMessageLink } from "../shared/toBoard";
import { EditableLabelChip, PriorityIcon, StatusIcon, stopEscape } from "./BoardParts";
import { Markdown } from "./Timeline";
import { cleanSlackText } from "../shared/inbox";
import { openFileRef, type FileRef } from "./fileRefs";
import { Branch, Close, Codicon, Edit, LinkIcon, OpenExternal, Plus, Refresh, Start, Trash } from "./icons";
import { rpc } from "./rpc";
import { boardFailed, closeCard, isTopWorkspace, openAgent, reanalyzeMention, startCardSession, useStore } from "./store";
import { confirmAction } from "./ConfirmDialog";
import { S } from "./strings";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { hint } from "./hint";
import { showMessage } from "./toBoardState";

// 카드 상세. 세션 오른쪽 패널의 "Card" 탭(selectedCardId)과 보드 화면의 상세 칸(cardId, onClose 를 넘김)이 같이 쓴다. 제목, 설명(마크다운), 라벨, 워크스페이스, 열, 연결된 세션, 링크를 편집하고 Start Session 을 누른다.
const NONE = "none";

export function CardDetail({ cardId: given, onClose }: { cardId?: string | null; onClose?: () => void }) {
  const panelCardId = useStore((s) => s.selectedCardId);
  const cardId = given === undefined ? panelCardId : given;
  const card = useStore((s) => s.board?.cards.find((c) => c.id === cardId));
  if (!card) return <div className="empty-hint">{S.noCardSelected}</div>;
  // 카드가 바뀌면 입력 상태를 새로 시작한다.
  return <CardForm key={card.id} card={card} onClose={onClose ?? closeCard} />;
}

function CardForm({ card, onClose }: { card: BoardCard; onClose: () => void }) {
  const board = useStore((s) => s.board);
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  // 이 카드를 만든 Slack 멘션 (cardId, 없으면 같은 링크). 있으면 출처와 Re-analyze 를 보인다.
  const source = useStore((s) => s.inbox?.items.find((i) => i.cardId === card.id || (!!i.permalink && card.links.some((l) => l.url === i.permalink))));
  const slackLink = card.links.find((l) => /\.slack\.com\/archives\//.test(l.url));
  const [title, setTitle] = useState(card.title);
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState(card.body);
  const [label, setLabel] = useState("");
  const [link, setLink] = useState("");

  // 다른 창이나 자동 이동이 바꾼 제목은 편집 중이 아닐 때 따라간다.
  useEffect(() => setTitle(card.title), [card.title]);
  useEffect(() => {
    if (!editingBody) setBody(card.body);
  }, [card.body, editingBody]);

  const patch = (change: CardPatch) => rpc.call("board.updateCard", { id: card.id, patch: change }).catch(boardFailed);
  const saveTitle = () => {
    const next = title.trim();
    if (!next) setTitle(card.title);
    else if (next !== card.title) void patch({ title: next });
  };
  const addLabel = () => {
    const next = label.trim();
    setLabel("");
    if (next && !card.labels.some((l) => l.toLowerCase() === next.toLowerCase())) void patch({ labels: [...card.labels, next] });
  };
  const addLink = () => {
    const url = link.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      hint(S.linkInvalid);
      return;
    }
    setLink("");
    void patch({ links: [...card.links, { url, title: null }] });
  };
  const remove = async () => {
    if (!(await confirmAction(S.confirmDeleteCard(card.title), S.deleteButton, undefined, "warning"))) return;
    onClose();
    rpc.call("board.deleteCard", { id: card.id }).catch(boardFailed);
  };

  const linkedAgents = card.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a) => !!a);
  const canStart = !!card.workspaceId;

  return (
    <div className="card-detail" aria-label={S.cardDetailAria}>
      <div className="card-detail-body">
        <div className="card-detail-key" aria-label={S.cardKeyAria(cardKey(card))}>
          {cardKey(card)}
        </div>
        <input
          className="input card-detail-title"
          aria-label={S.cardTitle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur();
            if (e.key === "Escape") {
              setTitle(card.title);
              e.currentTarget.blur();
            }
          }}
        />

        <div className="card-props" role="group" aria-label={S.cardProperties}>
          <div className="field-row">
            <label>{S.cardStatus}</label>
            <Select value={card.columnId} onValueChange={(columnId) => void rpc.call("board.moveCard", { id: card.id, columnId, index: Number.MAX_SAFE_INTEGER }).catch(boardFailed)}>
              <SelectTrigger boxed aria-label={S.cardStatus}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent onEscapeKeyDown={stopEscape}>
                {(board?.columns ?? []).map((column) => (
                  <SelectItem key={column.id} value={column.id}>
                    <span className="select-item-icon">
                      <StatusIcon role={column.role} />
                      {column.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field-row">
            <label>{S.priority}</label>
            <Select value={String(card.priority)} onValueChange={(value) => void patch({ priority: Number(value) as BoardPriority })}>
              <SelectTrigger boxed aria-label={S.priority}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent onEscapeKeyDown={stopEscape}>
                {S.priorityNames.map((name, i) => (
                  <SelectItem key={name} value={String(i)}>
                    <span className="select-item-icon">
                      <PriorityIcon priority={i as BoardPriority} />
                      {name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field-row" data-top="">
            <label>{S.cardLabels}</label>
            <div className="prop-value">
              <div className="card-labels">
                {card.labels.map((l) => (
                  <EditableLabelChip key={l} label={l} onPick={(color) => void rpc.call("board.setLabelColor", { label: l, color }).catch(boardFailed)} onRemove={() => void patch({ labels: card.labels.filter((x) => x !== l) })} />
                ))}
                <input
                  className="input label-input"
                  aria-label={S.addLabelPlaceholder}
                  placeholder={S.addLabelPlaceholder}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) addLabel();
                  }}
                />
              </div>
            </div>
          </div>
          <div className="field-row">
            <label>{S.cardWorkspace}</label>
            <Select value={card.workspaceId ?? NONE} onValueChange={(value) => void patch({ workspaceId: value === NONE ? null : value })}>
              <SelectTrigger boxed aria-label={S.cardWorkspace}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent onEscapeKeyDown={stopEscape}>
                <SelectItem value={NONE}>{S.noWorkspace}</SelectItem>
                {workspaces.filter(isTopWorkspace).map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field-row" data-top="" data-tall="">
            <label>{S.cardSessions}</label>
            <div className="prop-value">
              {linkedAgents.length === 0 && <div className="faint small">{S.noSessionsLinked}</div>}
              {linkedAgents.map((agent) => (
                <div key={agent.id} className="card-detail-row">
                  <button type="button" className="card-detail-open" onClick={() => openAgent(agent.id)}>
                    <span className="dot" data-state={agent.status} />
                    {agent.worktree && <Branch size={14} />}
                    <span className="card-session-title">{agent.title}</span>
                  </button>
                  <Button size="icon" aria-label={S.unlinkSession} title={S.unlinkSession} onClick={() => void rpc.call("board.unlinkAgent", { cardId: card.id, agentId: agent.id }).catch(boardFailed)}>
                    <Close />
                  </Button>
                </div>
              ))}
              <div className="card-detail-actions">
                <Button variant="secondary" size="sm" disabled={!canStart} title={canStart ? S.startSessionHint : S.startSessionNeedsWorkspace} onClick={() => startCardSession(card, false)}>
                  <Start size={14} /> {S.startSession}
                </Button>
                <Button variant="secondary" size="sm" disabled={!canStart} title={canStart ? S.startSessionHint : S.startSessionNeedsWorkspace} onClick={() => startCardSession(card, true)}>
                  <Branch size={14} /> {S.startSessionWorktree}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="card-detail-section">
          <div className="card-detail-section-head">
            <span className="section-label">{S.cardDescription}</span>
            {!editingBody && (
              <Button size="icon" aria-label={S.editDescription} title={S.editDescription} onClick={() => setEditingBody(true)}>
                <Edit />
              </Button>
            )}
          </div>
          {editingBody ? (
            <>
              <textarea className="input card-detail-textarea" aria-label={S.cardDescription} placeholder={S.cardDescriptionPlaceholder} value={body} autoFocus rows={8} onChange={(e) => setBody(e.target.value)} />
              <div className="card-detail-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setBody(card.body);
                    setEditingBody(false);
                  }}
                >
                  {S.cancel}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setEditingBody(false);
                    if (body !== card.body) void patch({ body });
                  }}
                >
                  {S.saveDescription}
                </Button>
              </div>
            </>
          ) : card.body.trim() ? (
            <div
              onClick={(event) => {
                // 대화에서 만든 카드의 "Go to message" 링크는 그 세션의 그 메시지로 간다.
                const back = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href^='#lodestar-message=']");
                const message = back && parseMessageLink(back.getAttribute("href") ?? "");
                if (message) {
                  event.preventDefault();
                  showMessage(message.agentId, message.itemId);
                  return;
                }
                // 설명 안의 파일 링크(관련 파일)는 카드의 워크스페이스에서 연다.
                const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
                if (!anchor || !card.workspaceId) return;
                event.preventDefault();
                void openFileRef(card.workspaceId, JSON.parse(anchor.dataset.file!) as FileRef, {}, event.altKey);
              }}
            >
              <Markdown className="card-detail-markdown" text={card.body} workspaceId={card.workspaceId} />
            </div>
          ) : (
            <div className="faint small">{S.noDescription}</div>
          )}
        </div>

        {card.source && <ConversationSource source={card.source} />}

        {(source || slackLink) && (
          <div className="card-detail-section" aria-label={S.mentionSource}>
            <span className="section-label">{S.mentionSource}</span>
            {source && (
              <div className="small" data-sensitive>
                {S.mentionFrom(source.from.name, source.channelName)}
              </div>
            )}
            {source && <div className="faint small" data-sensitive>{cleanSlackText(source.text).split("\n").find((l) => l.trim()) ?? ""}</div>}
            <div className="card-detail-actions">
              {(source?.permalink || slackLink) && (
                <a className="file-link card-link" href={source?.permalink || slackLink?.url} target="_blank" rel="noopener noreferrer">
                  <OpenExternal size={12} /> {S.openInSlack}
                </a>
              )}
              {source && (
                <Button size="sm" disabled={source.analysis?.status === "queued" || source.analysis?.status === "running"} title={S.reanalyzeTip} onClick={() => void reanalyzeMention(source.id)}>
                  <Refresh size={14} /> {source.analysis?.status === "running" ? S.mentionStatus.analyzing : source.analysis?.status === "queued" ? S.mentionStatus.queued : S.reanalyze}
                </Button>
              )}
            </div>
            {source?.analysis?.status === "failed" && <div className="inbox-error small">{S.analysisFailedTip(source.analysis.error ?? "")}</div>}
          </div>
        )}

        <div className="card-detail-section">
          <span className="section-label">{S.cardLinks}</span>
          {card.links.length === 0 && <div className="faint small">{S.noLinks}</div>}
          {card.links.map((l) => (
            <div key={l.url} className="card-detail-row">
              <a className="file-link card-link" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
                <LinkIcon size={14} />
                <span className="card-session-title">{l.title ?? l.url}</span>
                <OpenExternal size={12} />
              </a>
              <Button size="icon" aria-label={S.removeLink} title={S.removeLink} onClick={() => void patch({ links: card.links.filter((x) => x.url !== l.url) })}>
                <Close />
              </Button>
            </div>
          ))}
          <div className="card-detail-row">
            <input
              className="input grow-input"
              aria-label={S.addLink}
              placeholder={S.addLinkPlaceholder}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) addLink();
              }}
            />
            <Button size="icon" aria-label={S.addLink} title={S.addLink} onClick={addLink}>
              <Plus />
            </Button>
          </div>
        </div>

        <div className="card-detail-footer faint xs">
          <span title={new Date(card.createdAt).toLocaleString()}>{S.cardCreated(new Date(card.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}</span>
          <span className="spacer" />
          <Button variant="ghost" size="sm" onClick={remove}>
            <Trash size={14} /> {S.deleteCard}
          </Button>
        </div>
      </div>
    </div>
  );
}

// 대화의 한 부분(Add to Board)에서 만든 카드가 그 세션과 메시지로 돌아가는 곳. 세션이 지워졌으면 비활성.
function ConversationSource({ source }: { source: CardSource }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === source.agentId));
  return (
    <div className="card-detail-section" aria-label={S.cardConversation}>
      <span className="section-label">{S.cardConversation}</span>
      <div className="faint small card-session-title">{agent?.title ?? S.cardSessionGone}</div>
      <div className="card-detail-actions">
        <Button variant="secondary" size="sm" disabled={!agent} data-action="go-to-message" title={agent ? undefined : S.cardSessionGone} onClick={() => showMessage(source.agentId, source.itemId)}>
          <Codicon name="comment-discussion" size={14} /> {S.cardGoToMessage}
        </Button>
      </div>
    </div>
  );
}
