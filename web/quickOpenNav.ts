export const QUICK_OPEN_NAVIGATE = "agent-nav:quick-open-navigate";

export function navigateQuickOpen(next: boolean) {
  window.dispatchEvent(new CustomEvent<boolean>(QUICK_OPEN_NAVIGATE, { detail: next }));
}
