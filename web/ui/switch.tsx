import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

// 켜고 끄는 스위치(role=switch). 트랙 36x20, 손잡이 16, 켜면 accent. 크기와 모양은 styles.css 의 .switch 가 정한다.
type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked: boolean; onCheckedChange: (checked: boolean) => void };

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch({ checked, onCheckedChange, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" role="switch" aria-checked={checked} data-state={checked ? "checked" : "unchecked"} className={cn("switch", className)} onClick={() => onCheckedChange(!checked)} {...props}>
      <span className="switch-thumb" />
    </button>
  );
});
