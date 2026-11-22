import type { PrDetail, PrTimelineEntry } from "../shared/prTypes";
import { CheckIcon, PrAvatar, useNow } from "./PrBits";
import { PrComposer } from "./PrComposer";
import { PrMarkdown } from "./PrMarkdown";
import { PrMerge } from "./PrMerge";
import { PrCommentView } from "./PrThread";
import { Codicon } from "./icons";
import { usePrActions, usePrView } from "./prStore";
import { P } from "./prStrings";
import { relativeTime } from "./sessionList";

export function PrOverview({ detail }: { detail: PrDetail }) {
  const busy = usePrView((v) => v.busy !== null);
  const actions = usePrActions();
  return (
    <div className="pr-overview" key={detail.id}>
      <div className="pr-overview-main">
        {detail.truncated && <div className="pr-note-box">{P.truncated}</div>}
        <section className="pr-card" aria-label={P.description}>
          <div className="pr-card-head">
            <PrAvatar user={detail.author} size={20} />
            <span className="pr-comment-author">{detail.author?.login ?? "ghost"}</span>
          </div>
          {detail.body.trim() ? <PrMarkdown text={detail.body} /> : <span className="pr-faint">{P.noDescription}</span>}
        </section>
        <h3 className="pr-section-title">{P.timeline}</h3>
        <div className="pr-timeline">
          {detail.timeline.map((entry) => (
            <TimelineEntry key={entry.kind === "comment" ? entry.comment.id : entry.id} entry={entry} />
          ))}
        </div>
        <PrMerge detail={detail} />
        <PrComposer label={P.addComment} placeholder={P.commentPlaceholder} busy={busy} actions={[{ label: P.comment, primary: true, run: (body) => actions.addTimelineComment(body) }]} />
      </div>
      <aside className="pr-overview-side" aria-label="Details">
        <SideBlock title={P.reviewers}>
          {detail.reviewers.length === 0 && <span className="pr-faint">{P.none}</span>}
          {detail.reviewers.map((reviewer) => (
            <div key={reviewer.name} className="pr-person">
              <PrAvatar user={{ login: reviewer.name, avatarUrl: reviewer.avatarUrl }} size={16} />
              <span className="pr-person-name">{reviewer.name}</span>
              <span className="pr-person-state" data-state={reviewer.state} title={reviewer.state === "REQUESTED" ? P.requested : P.reviewedState[reviewer.state]}>
                <Codicon name={reviewer.state === "APPROVED" ? "pass" : reviewer.state === "CHANGES_REQUESTED" ? "request-changes" : reviewer.state === "REQUESTED" ? "eye" : "comment"} size={14} />
              </span>
            </div>
          ))}
        </SideBlock>
        <SideBlock title={P.assignees}>
          {detail.assignees.length === 0 && <span className="pr-faint">{P.none}</span>}
          {detail.assignees.map((user) => (
            <div key={user.login} className="pr-person">
              <PrAvatar user={user} size={16} />
              <span className="pr-person-name">{user.login}</span>
            </div>
          ))}
        </SideBlock>
        <SideBlock title={P.labels}>
          {detail.labels.length === 0 && <span className="pr-faint">{P.none}</span>}
          <div className="pr-labels">
            {detail.labels.map((label) => (
              <span key={label.name} className="pr-label" style={{ "--label-color": `#${label.color}` } as React.CSSProperties}>
                {label.name}
              </span>
            ))}
          </div>
        </SideBlock>
        <SideBlock title={P.checks} anchor="checks">
          {detail.checkList.length === 0 && <span className="pr-faint">{P.none}</span>}
          {detail.checkList.map((check) => (
            <div key={check.name} className="pr-check-row">
              <CheckIcon kind={check.state} />
              {check.url ? (
                <a href={check.url} target="_blank" rel="noreferrer" className="pr-check-name" title={check.name}>
                  {check.name}
                </a>
              ) : (
                <span className="pr-check-name" title={check.name}>
                  {check.name}
                </span>
              )}
              <span className="pr-faint">{check.detail}</span>
            </div>
          ))}
        </SideBlock>
      </aside>
    </div>
  );
}

function SideBlock({ title, anchor, children }: { title: string; anchor?: string; children: React.ReactNode }) {
  return (
    <section className="pr-side-block" data-pr-anchor={anchor}>
      <h4 className="pr-side-title">{title}</h4>
      {children}
    </section>
  );
}

function TimelineEntry({ entry }: { entry: PrTimelineEntry }) {
  const now = useNow();
  if (entry.kind === "comment") return <PrCommentView comment={entry.comment} kind="issue" />;
  return (
    <article className="pr-card pr-review-entry" data-state={entry.state} data-pr-anchor={entry.anchorId ? `review-${entry.anchorId}` : undefined}>
      <div className="pr-card-head">
        <PrAvatar user={entry.author} size={20} />
        <span className="pr-comment-author">{entry.author?.login ?? "ghost"}</span>
        <span className="pr-faint">{P.reviewedState[entry.state]}</span>
        <span className="pr-faint" title={entry.createdAt}>
          {relativeTime(entry.createdAt, now)}
        </span>
      </div>
      {entry.body.trim() && <PrMarkdown text={entry.body} />}
    </article>
  );
}
