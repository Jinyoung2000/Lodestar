import type { DiffFeedback, UserAttachment } from "../shared/protocol";
import { chipText, lineRangeLabel } from "../shared/diffFeedback";
import { clearDiffFeedback, removeDiffFeedback, revealDiffFeedback, useDiffFeedback, pendingOf } from "./diffFeedbackState";
import { Close, Codicon } from "./icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { S } from "./strings";

export function ComposerFeedback({ agentId }: { agentId: string }) {
  const pending = pendingOf(useDiffFeedback(agentId));
  if (pending.length === 0) return null;
  const single = pending.length === 1 ? pending[0] : null;
  const label = chipText(pending);
  return (
    <span className="feedback-chip-group" data-testid="feedback-chip">
      {single ? (
        <button type="button" className="feedback-chip" aria-label={S.fbAttached(label)} title={`${single.rel}:${lineRangeLabel(single)}\n${single.text}`} onClick={() => revealDiffFeedback(agentId, { path: single.path, line: single.startLine, id: single.id })}>
          <Codicon name="comment" size={12} />
          <span className="feedback-chip-text">{label}</span>
          <ClearButton agentId={agentId} />
        </button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="feedback-chip" aria-label={S.fbAttached(label)} title={S.fbViewComments}>
              <Codicon name="comment" size={12} />
              <span className="feedback-chip-text">{label}</span>
              <ClearButton agentId={agentId} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" aria-label={S.fbListAria}>
            <FeedbackList agentId={agentId} items={pending} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  );
}

function ClearButton({ agentId }: { agentId: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="feedback-chip-remove"
      aria-label={S.fbRemoveAll}
      title={S.fbRemoveAll}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        clearDiffFeedback(agentId);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        clearDiffFeedback(agentId);
      }}
    >
      <Close size={12} />
    </span>
  );
}

function FeedbackList({ agentId, items }: { agentId: string; items: DiffFeedback[] }) {
  const files = [...new Set(items.map((i) => i.path))];
  return (
    <div className="feedback-list">
      {files.map((path) => {
        const rows = items.filter((i) => i.path === path);
        return (
          <div key={path}>
            <div className="feedback-list-file" title={rows[0].rel}>
              <Codicon name="file" size={12} />
              <span className="feedback-chip-text">{rows[0].rel}</span>
            </div>
            {rows.map((row) => (
              <div key={row.id} className="feedback-list-row" role="menuitem" tabIndex={0} title={row.text} onClick={() => revealDiffFeedback(agentId, { path: row.path, line: row.startLine, id: row.id })}>
                <span className="feedback-chip-text">{row.text}</span>
                <span className="feedback-chip-where">{lineRangeLabel(row)}</span>
                <span
                  role="button"
                  tabIndex={0}
                  className="feedback-chip-remove"
                  aria-label={S.fbRemove}
                  title={S.fbRemove}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeDiffFeedback(agentId, row.id);
                  }}
                >
                  <Close size={12} />
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function FeedbackAttachmentChip({ agentId, attachment }: { agentId: string; attachment: Extract<UserAttachment, { kind: "diffFeedback" }> }) {
  return (
    <button type="button" className="feedback-chip" data-testid="feedback-attachment" title={`${attachment.path}:${attachment.line}\n${attachment.text}`} onClick={() => revealDiffFeedback(agentId, { path: attachment.path, line: attachment.line, id: attachment.id })}>
      <Codicon name="comment" size={12} />
      <span className="feedback-chip-where">{attachment.label}</span>
    </button>
  );
}

export function FeedbackBodies({ attachments }: { attachments: UserAttachment[] }) {
  const bodies = attachments.flatMap((attachment) => (attachment.kind === "diffFeedback" && (attachment.text ?? "").trim() ? [attachment] : []));
  if (bodies.length === 0) return null;
  return (
    <div className="row-user feedback-bodies" data-testid="feedback-bodies">
      {bodies.map((attachment) => (
        <div key={attachment.id} className="feedback-body">
          {attachment.text}
        </div>
      ))}
    </div>
  );
}
