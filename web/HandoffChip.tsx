import { useEffect, useState } from "react";
import { Close, Codicon, DotSpinner } from "./icons";
import { useFlashingAttachment } from "./attachFlash";
import { rpc } from "./rpc";
import { flash, removeAttachment, updateAttachment, type Attachment } from "./store";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { S } from "./strings";

// HANDOFF: 보낸 첫 메시지 위에 붙는 인계 문서 칩. 누르면 문서 전문을 읽기 전용으로 본다(문서는 ~/.agent-nav/handoffs/<id>.md).
export function HandoffBubbleChip({ label, id }: { label: string; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="user-attachment user-attachment-handoff" title={`${label}\n${S.handoffOpenTip}`} onClick={() => setOpen(true)}>
        <Codicon name="note" size={12} />
        <span className="user-attachment-name">{label}</span>
      </button>
      {open && <HandoffDialog title={label} id={id} text={null} onClose={() => setOpen(false)} />}
    </>
  );
}

// 인계 문서 보기와 고치기. text 가 있으면(입력창 칩) 그 글을 고쳐 onSave 로 돌려주고, null 이면(보낸 메시지의 칩) id 로 읽어 와 읽기 전용으로 보인다.
export function HandoffDialog({ title, id, text, onSave, onClose }: { title: string; id: string | null; text: string | null; onSave?: (text: string) => void; onClose: () => void }) {
  const editable = text !== null && onSave !== undefined;
  const [value, setValue] = useState(text ?? "");
  const [loading, setLoading] = useState(text === null);
  useEffect(() => {
    if (text !== null || !id) return;
    void rpc
      .call("handoff.read", { id })
      .then((doc) => setValue(doc.text))
      .catch((error: Error) => flash(error.message))
      .finally(() => setLoading(false));
  }, [id, text]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent label={title} className="handoff-dialog">
        <div className="handoff-dialog-head">
          <Codicon name="note" size={14} />
          <span className="handoff-dialog-title">{title}</span>
          <span className="spacer" />
          {!editable && <span className="faint xs">{S.handoffReadOnly}</span>}
        </div>
        <textarea className="handoff-dialog-text mono" aria-label={title} value={loading ? S.loading : value} readOnly={!editable} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
        {editable && (
          <div className="handoff-dialog-actions">
            <Button onClick={onClose}>{S.cancel}</Button>
            <Button
              onClick={() => {
                onSave(value);
                onClose();
              }}
            >
              {S.handoffSave}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// 입력창 위 칩. 문서를 만드는 동안은 스피너를 달고(보내기도 막힌다), 다 되면 누르면 전문을 보고 고칠 수 있다.
export function HandoffComposerChip({ paneId, attachment }: { paneId: string; attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const handoff = attachment.handoff!;
  const generating = handoff.status === "generating";
  const label = S.handoffChipLabel(handoff.title);
  const flashing = useFlashingAttachment();
  return (
    <span className="attachment handoff-chip" data-generating={generating || undefined} data-flash={flashing?.id === attachment.id || undefined}>
      <button type="button" className="handoff-chip-main" title={generating ? `${label} (${S.handoffGenerating}...)` : `${label}\n${S.handoffEditTip}`} disabled={generating} onClick={() => setOpen(true)}>
        {generating ? <DotSpinner size={12} /> : <Codicon name="note" size={12} />}
        <span className="handoff-chip-label">{generating ? S.handoffGenerating : label}</span>
      </button>
      <button type="button" className="attachment-remove" aria-label={S.removeAttachmentNamed(label)} onClick={() => removeAttachment(paneId, attachment.id)}>
        <Close size={12} />
      </button>
      {open && (
        <HandoffDialog
          title={label}
          id={handoff.id}
          text={attachment.text ?? ""}
          onSave={(text) => {
            updateAttachment(paneId, attachment.id, { text });
            if (handoff.id) void rpc.call("handoff.save", { id: handoff.id, text }).catch((error: Error) => flash(error.message));
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
