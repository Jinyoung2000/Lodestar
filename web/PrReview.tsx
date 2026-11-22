import { useEffect, useRef, useState } from "react";
import { Codicon } from "./icons";
import { usePrActions, usePrView } from "./prStore";
import { P } from "./prStrings";
import { Button } from "./ui/button";

type Event = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export function PrReview() {
  const detail = usePrView((v) => v.detail);
  const busy = usePrView((v) => v.busy !== null);
  const actions = usePrActions();
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<Event>("COMMENT");
  const [body, setBody] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (host.current && !host.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const prId = detail?.id;
  useEffect(() => {
    setOpen(false);
    setEvent("COMMENT");
    setBody("");
    setConfirmDiscard(false);
  }, [prId]);

  if (!detail || detail.state !== "OPEN") return null;
  const own = !!detail.viewer && detail.viewer.login === detail.author?.login;
  const pendingCount = detail.pendingReview?.comments ?? 0;
  const needsBody = event === "REQUEST_CHANGES" || (event === "COMMENT" && pendingCount === 0);
  const blocked = busy || (own && event !== "COMMENT") || (needsBody && body.trim() === "");

  const options: { value: Event; label: string; hint: string }[] = [
    { value: "COMMENT", label: P.eventComment, hint: P.eventCommentHint },
    { value: "APPROVE", label: P.eventApprove, hint: P.eventApproveHint },
    { value: "REQUEST_CHANGES", label: P.eventRequest, hint: P.eventRequestHint },
  ];

  return (
    <div className="pr-review" ref={host}>
      <Button variant={pendingCount > 0 ? "primary" : "secondary"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Codicon name="comment-discussion" size={14} />
        {P.finishReview}
        {pendingCount > 0 && <span className="pr-count">{pendingCount}</span>}
        <Codicon name="chevron-down" size={12} />
      </Button>
      {open && (
        <div className="pr-review-panel" role="dialog" aria-label={P.submitReview}>
          {pendingCount > 0 && <div className="pr-review-pending">{P.pendingComments(pendingCount)}</div>}
          <textarea className="pr-composer-input" aria-label={P.reviewBodyPlaceholder} placeholder={P.reviewBodyPlaceholder} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="pr-review-options" role="radiogroup">
            {options.map((option) => {
              const disabled = own && option.value !== "COMMENT";
              return (
                <label key={option.value} className="pr-review-option" data-disabled={disabled || undefined} title={disabled ? P.ownPr : undefined}>
                  <input type="radio" name="pr-review-event" value={option.value} checked={event === option.value} disabled={disabled} onChange={() => setEvent(option.value)} />
                  <span className="pr-review-option-text">
                    <span>{option.label}</span>
                    <span className="pr-faint">{disabled ? P.ownPr : option.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="pr-composer-actions">
            {detail.pendingReview &&
              (confirmDiscard ? (
                <>
                  <span className="pr-faint">{P.discardConfirm}</span>
                  <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                    {P.cancel}
                  </Button>
                  <Button
                    variant="primary"
                    className="pr-danger"
                    disabled={busy}
                    onClick={() =>
                      void actions.discardReview().then(() => {
                        setConfirmDiscard(false);
                        setOpen(false);
                      })
                    }
                  >
                    {P.discardReview}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
                  {P.discardReview}
                </Button>
              ))}
            <span className="spacer" />
            <Button
              variant="primary"
              disabled={blocked}
              title={needsBody && body.trim() === "" ? P.needBody : undefined}
              onClick={() =>
                void actions.submitReview(event, body).then((done) => {
                  if (!done) return;
                  setBody("");
                  setEvent("COMMENT");
                  setOpen(false);
                })
              }
            >
              {P.submitReview}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
