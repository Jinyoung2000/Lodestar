import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "../icons";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/utils";

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-overlay text-accent-fg outline-none cursor-pointer data-[state=checked]:border-accent data-[state=checked]:bg-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check size={12} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
