import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked: boolean; onCheckedChange: (checked: boolean) => void };

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch({ checked, onCheckedChange, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" role="switch" aria-checked={checked} data-state={checked ? "checked" : "unchecked"} className={cn("switch", className)} onClick={() => onCheckedChange(!checked)} {...props}>
      <span className="switch-thumb" />
    </button>
  );
});
