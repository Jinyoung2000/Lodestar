import type { QuickEntryConfig, QuickShortcutStatus } from "../shared/quickEntry";

// 빠른 입력창이 preload(electron/preload.ts)에서 받는 네이티브 함수. 메인 창은 configure, status 를, 빠른 입력창 페이지는 close, resize, finish, onShow 를 쓴다.
// 브라우저 탭(Electron 밖)에서는 window.agentNavNative 가 없다.
export type QuickEntryNative = {
  quickEntryConfigure?: (config: QuickEntryConfig) => Promise<QuickShortcutStatus>;
  quickEntryStatus?: () => Promise<QuickShortcutStatus>;
  onQuickEntryStatus?: (listener: (status: QuickShortcutStatus) => void) => () => void;
  quickEntryClose?: () => Promise<void>;
  quickEntryResize?: (cardHeight: number) => Promise<void>;
  quickEntryFinish?: (result: { agentId: string; stay: boolean }) => Promise<void>;
  quickEntrySwitch?: (agentId: string | null) => Promise<void>;
  quickEntryPinned?: (pinned: boolean) => Promise<void>;
  quickEntryOpenInMain?: (agentId: string) => Promise<void>;
  quickEntryHost?: (message: unknown) => Promise<void>;
  onQuickEntryShow?: (listener: () => void) => () => void;
};
