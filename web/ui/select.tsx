import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "../icons";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/utils";

// shadcn/ui Select 를 디자인 시스템에 맞춘 것. 트리거는 고스트 칩(24px), 목록은 surface-overlay + border + shadow-overlay.
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { boxed?: boolean }>(function SelectTrigger(
  { className, children, boxed = false, ...props },
  ref,
) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm text-ui-sm outline-none cursor-pointer focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:text-fg-subtle",
        boxed ? "h-(--size-control) px-2 border border-border bg-surface-overlay text-fg" : "h-(--size-control-sm) px-1.5 text-fg-muted hover:bg-surface-hover hover:text-fg",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="chip-chevron" size={12} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={4}
        className={cn("z-50 min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-surface-overlay p-1 text-fg shadow-overlay", className)}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex h-(--size-row-lg) cursor-pointer select-none items-center rounded-sm pl-6 pr-2 text-ui-sm outline-none data-[highlighted]:bg-surface-hover data-[highlighted]:text-fg-strong data-[disabled]:text-fg-subtle",
        className,
      )}
      {...props}
    >
      <span className="absolute left-1.5 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator className="inline-flex">
          <Check size={12} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
});
