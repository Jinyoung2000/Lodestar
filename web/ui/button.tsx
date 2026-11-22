import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-ui-sm font-normal outline-none transition-none select-none disabled:bg-transparent disabled:border-transparent disabled:text-fg-subtle disabled:cursor-default focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg font-semibold border border-transparent",
        secondary: "bg-surface-overlay text-fg border border-border hover:bg-surface-hover",
        ghost: "bg-transparent text-fg-muted border border-transparent hover:bg-surface-hover hover:text-fg",
        "ghost-on": "bg-surface-selected text-fg border border-transparent",
      },
      size: {
        default: "h-(--size-control) px-3",
        sm: "h-(--size-control-sm) px-2",
        icon: "h-(--size-control-sm) w-(--size-control-sm) px-0 rounded-sm",
      },
    },
    defaultVariants: { variant: "ghost", size: "sm" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, asChild = false, type = "button", ...props }, ref) {
  const Comp = asChild ? Slot : "button";
  const title = props.title ?? (size === "icon" ? props["aria-label"] : undefined);
  return <Comp ref={ref} type={asChild ? undefined : type} data-variant={variant ?? "ghost"} className={cn(buttonVariants({ variant, size }), className)} {...props} title={title} />;
});

export { buttonVariants };
