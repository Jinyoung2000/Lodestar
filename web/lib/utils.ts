import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui 관례: 클래스 합치기
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
