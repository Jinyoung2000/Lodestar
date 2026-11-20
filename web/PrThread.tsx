import { useEffect, useState } from "react";
import type { PrComment, PrThread } from "../shared/prTypes";
import { PrAvatar, useNow } from "./PrBits";
import { PrComposer } from "./PrComposer";
import { PrMarkdown } from "./PrMarkdown";
import { Codicon } from "./icons";
import { usePrActions, usePrView } from "./prStore";
import { P } from "./prStrings";
import { relativeTime } from "./sessionList";
import { Button } from "./ui/button";

// 리뷰 스레드 한 묶음. diff 줄 아래에 붙고, 해결된 스레드는 한 줄로 접힌다.
export function PrThreadView({ thread, original }: { thread: PrThread; original?: string[] }) {
  // 주소가 이 스레드의 코멘트를 가리키면 해결된 스레드여도 펼쳐서 보인다
  const focused = usePrView((v) => {
    const focus = v.focus;
    return focus?.kind === "comment" && thread.comments.some((c) => c.anchorId === focus.id);
  });
  const [expanded, setExpanded] = useState(!thread.isResolved || focused);
  // 해결하면 접고, 다시 열면 펼친다
  useEffect(() => setExpanded(!thread.isResolved), [thread.isResolved]);
  // 주소로 찾아온 스레드는 화면이 앵커를 처리한 뒤(focus 가 지워진 뒤)에도 펼친 채 둔다
  useEffect(() => {
    if (focused) setExpanded(true);
  }, [focused]);
  const busy = usePrView((v) => v.busy !== null);
  const pendingReview = usePrView((v) => v.detail?.pendingReview ?? null);
  const actions = usePrActions();
  const [replying, setReplying] = useState(false);
  const range = thread.startLine !== null && thread.line !== null && thread.startLine !== thread.line ? P.lineRange(thread.startLine, thread.line) : thread.line !== null ? P.lineRange(thread.line, thread.line) : null;

  return (
    <div className="pr-thread" data-resolved={thread.isResolved || undefined} data-outdated={thread.isOutdated || undefined}>
      <div className="pr-thread-head">
        <Codicon name={thread.isResolved ? "pass" : "comment"} size={14} />
        <span className="pr-thread-label">{thread.isResolved ? P.resolved : thread.isOutdated ? P.outdated : (range ?? "")}</span>
        {(thread.isResolved || thread.isOutdated) && range && <span className="pr-faint">{range}</span>}
        <span className="spacer" />
        {thread.isResolved && (
          <button type="button" className="pr-link-button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? P.hideResolved : P.showResolved}
          </button>
        )}
        {expanded && thread.viewerCanResolve && !thread.isResolved && (
          <Button variant="secondary" disabled={busy} onClick={() => void actions.setResolved(thread.id, true)}>
            {P.resolveThread}
          </Button>
        )}
        {expanded && thread.viewerCanUnresolve && thread.isResolved && (
          <Button variant="secondary" disabled={busy} onClick={() => void actions.setResolved(thread.id, false)}>
            {P.unresolveThread}
          </Button>
        )}
      </div>
      {expanded && (
        <>
          <div className="pr-thread-comments">
            {thread.comments.map((comment, index) => (
              <PrCommentView key={comment.id} comment={comment} kind="review" original={index === 0 ? original : undefined} />
            ))}
          </div>
          {replying ? (
            <PrComposer
              label={P.reply}
              placeholder={P.replyPlaceholder}
              busy={busy}
              autoFocus
              onCancel={() => setReplying(false)}
              actions={[
                {
                  label: pendingReview ? P.addReviewComment : P.reply,
                  primary: true,
                  run: async (body) => {
                    const done = await actions.replyTo(thread.id, body);
                    if (done) setReplying(false);
                    return done;
                  },
                },
              ]}
            />
          ) : (
            <button type="button" className="pr-reply-stub" onClick={() => setReplying(true)}>
              {P.replyPlaceholder}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// 코멘트 하나. 내 코멘트(viewerCanUpdate, viewerCanDelete)만 수정과 삭제가 보인다. 삭제는 한 번 더 눌러야 실행된다.
export function PrCommentView({ comment, kind, original }: { comment: PrComment; kind: "review" | "issue"; original?: string[] }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const busy = usePrView((v) => v.busy !== null);
  const actions = usePrActions();
  const now = useNow();
  return (
    <article className="pr-comment" data-pending={comment.pending || undefined} data-pr-anchor={comment.anchorId ? `comment-${comment.anchorId}` : undefined}>
      <div className="pr-comment-head">
        <PrAvatar user={comment.author} size={20} />
        <span className="pr-comment-author">{comment.author?.login ?? "ghost"}</span>
        <span className="pr-faint" title={comment.createdAt}>
          {relativeTime(comment.createdAt, now)}
        </span>
        {comment.pending && <span className="pr-badge">{P.pendingBadge}</span>}
        <span className="spacer" />
        {!editing && comment.viewerCanUpdate && (
          <Button size="icon" aria-label={P.edit} title={P.edit} onClick={() => setEditing(true)}>
            <Codicon name="edit" size={14} />
          </Button>
        )}
        {!editing && comment.viewerCanDelete && !confirming && (
          <Button size="icon" aria-label={P.delete} title={P.delete} onClick={() => setConfirming(true)}>
            <Codicon name="trash" size={14} />
          </Button>
        )}
        {confirming && (
          <>
            <span className="pr-faint">{P.deleteConfirm}</span>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {P.cancel}
            </Button>
            <Button variant="primary" className="pr-danger" disabled={busy} onClick={() => void actions.deleteComment(comment.id, kind)}>
              {P.delete}
            </Button>
          </>
        )}
      </div>
      {editing ? (
        <PrComposer
          label={P.edit}
          placeholder=""
          initial={comment.body}
          busy={busy}
          autoFocus
          onCancel={() => setEditing(false)}
          actions={[
            {
              label: P.save,
              primary: true,
              run: async (body) => {
                const done = await actions.editComment(comment.id, kind, body);
                if (done) setEditing(false);
                return done;
              },
            },
          ]}
        />
      ) : (
        <PrMarkdown text={comment.body} original={original} />
      )}
    </article>
  );
}
