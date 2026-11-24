import { useMemo, useState } from "react";
import { previewFrameDocument, readPreviewCard, type PreviewFrame } from "../shared/previewCard";
import { Maximize } from "./icons";
import { S } from "./strings";
import { Dialog, DialogContent } from "./ui/dialog";

export type PreviewCardProps = { input: Record<string, unknown> };

export function PreviewCard({ input }: PreviewCardProps) {
  const card = useMemo(() => readPreviewCard(input), [input]);
  const [expanded, setExpanded] = useState<{ html: string; title: string } | null>(null);
  if (!card) return null;
  const titleOf = (frame: PreviewFrame, index: number) => frame.label || S.previewFrameTitle(index + 1);
  return (
    <section className="preview-card" aria-label={card.title || S.previewCardAria}>
      {card.title && <div className="preview-card-title">{card.title}</div>}
      <div className="preview-frames">
        {card.frames.map((frame, index) => (
          <figure key={index} className="preview-frame">
            <figcaption className="preview-frame-head">
              <span className="preview-frame-label">{titleOf(frame, index)}</span>
              <ExpandButton onClick={() => setExpanded({ html: frame.html, title: titleOf(frame, index) })} />
            </figcaption>
            <HtmlFrame html={frame.html} title={titleOf(frame, index)} />
          </figure>
        ))}
      </div>
      {expanded && <PreviewDialog html={expanded.html} title={expanded.title} onClose={() => setExpanded(null)} />}
    </section>
  );
}

export function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-button preview-expand" aria-label={S.previewExpand} title={S.previewExpand} onClick={onClick}>
      <Maximize size={14} />
    </button>
  );
}

export function PreviewDialog({ html, title, onClose }: { html: string; title: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent label={title} className="preview-dialog">
        <HtmlFrame html={html} title={title} expanded />
      </DialogContent>
    </Dialog>
  );
}

export function HtmlFrame({ html, title, expanded = false }: { html: string; title: string; expanded?: boolean }) {
  const doc = useMemo(() => previewFrameDocument(html, "Canvas"), [html]);
  const [height, setHeight] = useState<number | null>(null);
  return (
    <iframe
      className="preview-frame-view"
      data-expanded={expanded || undefined}
      title={title}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={height === null || expanded ? undefined : { minHeight: height }}
      onLoad={(e) => setHeight(e.currentTarget.contentDocument?.body.scrollHeight ?? null)}
    />
  );
}
