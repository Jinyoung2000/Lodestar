import type { QuickEntryConfig, QuickShortcutStatus } from "../shared/quickEntry";

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
