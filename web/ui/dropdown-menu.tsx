import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Check, ChevronRight } from "../icons";
import { cn } from "../lib/utils";

// shadcn/ui DropdownMenu. 항목 높이 28px(size-row-lg), 좌우 space-2.
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export const DropdownMenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn("z-50 min-w-(--size-control) rounded-md border border-border bg-surface-overlay p-1 text-fg shadow-overlay", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }>(function DropdownMenuItem({ className, danger, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "flex h-(--size-row-lg) cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-ui-sm outline-none data-[highlighted]:bg-surface-hover data-[highlighted]:text-fg-strong",
        danger && "text-danger data-[highlighted]:text-danger",
        className,
      )}
      {...props}
    />
  );
});

export const DropdownMenuSeparator = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.Separator ref={ref} className={cn("my-1 h-px bg-border-subtle", className)} {...props} />;
});

// B1: 서브메뉴와 체크 표시 항목(사이드바 필터 메뉴). 선택된 항목은 왼쪽 체크 칸에 체크가 보이고, 선택되지 않은 항목도 같은 칸을 비워 글자 줄이 맞는다.
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const ROW = "flex h-(--size-row-lg) cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-ui-sm outline-none data-[highlighted]:bg-surface-hover data-[highlighted]:text-fg-strong data-[state=open]:bg-surface-hover";

export const DropdownMenuSubTrigger = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>>(function DropdownMenuSubTrigger({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger ref={ref} className={cn(ROW, className)} {...props}>
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
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={cn("z-50 min-w-(--size-control) rounded-md border border-border bg-surface-overlay p-1 text-fg shadow-overlay", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export const DropdownMenuRadioItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem ref={ref} className={cn(ROW, className)} {...props}>
      <span className="flex w-(--size-icon) shrink-0 items-center justify-center">
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
      <span className="flex w-(--size-icon) shrink-0 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
