import * as DialogPrimitive from "@radix-ui/react-dialog";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/utils";

// shadcn/ui Dialog. 팔레트와 설정 패널이 쓴다: 위에서 10vh 내려온 surface-overlay 상자, radius-lg, shadow-overlay.
export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { label: string; overlayClassName?: string }>(function DialogContent({ className, children, label, overlayClassName, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={cn("fixed inset-0 z-40 bg-surface-base/60", overlayClassName)} />
      <DialogPrimitive.Content
        ref={ref}
        aria-label={label}
        className={cn("palette fixed left-1/2 top-[10vh] z-50 flex max-h-[60vh] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface-overlay text-fg shadow-overlay outline-none", className)} // lint-tokens: allow 팔레트 위치(10vh)와 높이(60vh)는 뷰포트 비율
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
