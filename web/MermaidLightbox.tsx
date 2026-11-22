import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Codicon } from "./icons";
import { S } from "./strings";

export function MermaidLightbox({ svg, onClose }: { svg: SVGSVGElement; onClose: () => void }) {
  const mount = (el: HTMLDivElement | null) => {
    if (!el) return;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.removeAttribute("width");
    copy.removeAttribute("height");
    el.replaceChildren(copy);
  };
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="confirm-overlay" />
        <DialogPrimitive.Content className="aside-lightbox mermaid-lightbox" aria-describedby={undefined}>
          <DialogPrimitive.Title className="aside-lightbox-title">{S.mermaidPreview}</DialogPrimitive.Title>
          <DialogPrimitive.Close className="confirm-close" aria-label={S.close}>
            <Codicon name="close" />
          </DialogPrimitive.Close>
          <div className="mermaid-preview mermaid-lightbox-body" ref={mount} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
