import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Check, ChevronRight } from "../icons";
import { cn } from "../lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const PANEL = "z-50 min-w-(--size-control) rounded-md border border-border-overlay bg-surface-overlay p-1 text-fg-strong shadow-overlay";

export const DropdownMenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn(PANEL, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
});

const ROW = "flex h-(--size-row-lg) cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-ui-sm outline-none data-[highlighted]:bg-surface-selected data-[disabled]:cursor-default data-[disabled]:text-fg-subtle";

export const DropdownMenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }>(function DropdownMenuItem({ className, danger, ...props }, ref) {
  return <DropdownMenuPrimitive.Item ref={ref} className={cn(ROW, danger && "text-danger", className)} {...props} />;
});

export const DropdownMenuSeparator = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
});

export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export const DropdownMenuSubTrigger = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>>(function DropdownMenuSubTrigger({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger ref={ref} className={cn(ROW, "data-[state=open]:bg-surface-selected", className)} {...props}>
      {children}
      <span className="ml-auto flex text-fg-muted">
        <ChevronRight />
      </span>
    </DropdownMenuPrimitive.SubTrigger>
  );
});

export const DropdownMenuSubContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>>(function DropdownMenuSubContent({ className, sideOffset = 2, alignOffset = -5, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent ref={ref} sideOffset={sideOffset} alignOffset={alignOffset} className={cn(PANEL, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuRadioItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem ref={ref} className={cn(ROW, className)} {...props}>
      <span className="flex w-(--size-icon) shrink-0 items-center justify-center text-accent-text">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
});

export const DropdownMenuCheckboxItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem ref={ref} className={cn(ROW, className)} {...props}>
      <span className="flex w-(--size-icon) shrink-0 items-center justify-center text-accent-text">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
