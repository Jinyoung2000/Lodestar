import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { QuickEntryConfig, QuickShortcutStatus } from "../shared/quickEntry";

export type CaptureRect = { x: number; y: number; width: number; height: number };

export type NotifyPayload = { agentId: string; kind: "response" | "approval"; title: string; body: string; itemId?: string; actionLabel?: string };

contextBridge.exposeInMainWorld("agentNavNative", {
  captureElement: (rect: CaptureRect): Promise<string | null> => ipcRenderer.invoke("agent-nav:capture", rect),
  notify: (payload: NotifyPayload): Promise<boolean> => ipcRenderer.invoke("agent-nav:notify", payload),
  clearNotification: (agentId: string): Promise<void> => ipcRenderer.invoke("agent-nav:notify-clear", agentId),
  setBadgeCount: (count: number): Promise<void> => ipcRenderer.invoke("agent-nav:badge", count),
  browserPick: (id: number, mode: "element" | "comment" | "area", options?: { image?: boolean }) => ipcRenderer.invoke("agent-nav:browser-pick", id, mode, options),
  onBrowserComment: (listener: (payload: { id: number; item: unknown }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: number; item: unknown }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-comment", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-comment", handler);
  },
  browserConsole: (id: number) => ipcRenderer.invoke("agent-nav:browser-console", id),
  browserTool: (id: number, tool: string, args: Record<string, unknown>) => ipcRenderer.invoke("agent-nav:browser-tool", id, tool, args),
  onBrowserPermission: (listener: (payload: { requestId: string; origin: string; category: string }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { requestId: string; origin: string; category: string }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-permission", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-permission", handler);
  },
  browserPermissionAnswer: (requestId: string, answer: "allow" | "deny" | null): Promise<void> => ipcRenderer.invoke("agent-nav:browser-permission-answer", requestId, answer),
  browserPermissionsGet: (url: string) => ipcRenderer.invoke("agent-nav:browser-permissions-get", url),
  browserPermissionsSet: (url: string, changes: { category: string; state: "allow" | "deny" | null }[]): Promise<void> => ipcRenderer.invoke("agent-nav:browser-permissions-set", url, changes),
  browserPickCancel: (id: number): Promise<void> => ipcRenderer.invoke("agent-nav:browser-pick-cancel", id),
  browserCapture: (id: number) => ipcRenderer.invoke("agent-nav:browser-capture", id),
  browserClearStorage: (partition?: string): Promise<void> => ipcRenderer.invoke("agent-nav:browser-clear-storage", partition),
  onBrowserDialog: (listener: (payload: { id: number; dialog: { type: string; message: string; defaultPrompt: string } | null }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: number; dialog: { type: string; message: string; defaultPrompt: string } | null }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-dialog", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-dialog", handler);
  },
  browserDialogAnswer: (id: number, accept: boolean, text?: string): Promise<void> => ipcRenderer.invoke("agent-nav:browser-dialog-answer", id, accept, text),
  onBrowserCommentRemoved: (listener: (payload: { id: number; number: number }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: number; number: number }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-comment-removed", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-comment-removed", handler);
  },
  browserCaptureFull: (id: number) => ipcRenderer.invoke("agent-nav:browser-capture-full", id),
  onBrowserFileChanged: (listener: (payload: { id: number }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: number }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-file-changed", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-file-changed", handler);
  },
  browserWatchFile: (id: number, enabled: boolean): Promise<void> => ipcRenderer.invoke("agent-nav:browser-watch-file", id, enabled),
  onBrowserDevice: (listener: (request: { requestId: string; origin: string; deviceType: string; devices: { deviceId: string; label: string; detail?: string }[] }) => void): (() => void) => {
    const handler = (_event: unknown, request: Parameters<typeof listener>[0]) => listener(request);
    ipcRenderer.on("agent-nav:browser-device", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-device", handler);
  },
  browserDeviceAnswer: (requestId: string, deviceId: string | null): Promise<void> => ipcRenderer.invoke("agent-nav:browser-device-answer", requestId, deviceId),
  readsWindowAfterDaemonRestart: true,
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  reloadWindow: (): Promise<void> => ipcRenderer.invoke("agent-nav:reload-window"),
  restartDaemon: (): Promise<boolean | "deferred"> => ipcRenderer.invoke("agent-nav:restart-daemon"),
  daemonState: (): Promise<{ state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number }> => ipcRenderer.invoke("agent-nav:daemon-state"),
  onDaemonState: (listener: (state: { state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number }) => void): (() => void) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("agent-nav:daemon-state", handler);
    return () => ipcRenderer.removeListener("agent-nav:daemon-state", handler);
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("agent-nav:pick-folder"),
  windowZoom: (action: "in" | "out" | "reset"): Promise<number> => ipcRenderer.invoke("agent-nav:zoom", action),
  newWindow: (): Promise<void> => ipcRenderer.invoke("agent-nav:new-window"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("agent-nav:close-window"),
  setOpenAgents: (agentIds: string[], layoutMode: "chat" | "editor"): Promise<void> => ipcRenderer.invoke("agent-nav:open-agents", agentIds, layoutMode),
  openNotificationSession: (agentId: string): Promise<void> => ipcRenderer.invoke("agent-nav:open-notification-session", agentId),
  windowIds: (): Promise<string[]> => ipcRenderer.invoke("agent-nav:window-ids"),
  onWindowsChanged: (listener: (ids: string[]) => void): (() => void) => {
    const handler = (_event: unknown, ids: string[]) => listener(ids);
    ipcRenderer.on("agent-nav:windows-changed", handler);
    return () => ipcRenderer.removeListener("agent-nav:windows-changed", handler);
  },
  quickEntryConfigure: (config: QuickEntryConfig): Promise<QuickShortcutStatus> => ipcRenderer.invoke("agent-nav:quick-configure", config),
  quickEntryStatus: (): Promise<QuickShortcutStatus> => ipcRenderer.invoke("agent-nav:quick-status"),
  onQuickEntryStatus: (listener: (status: QuickShortcutStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: QuickShortcutStatus) => listener(status);
    ipcRenderer.on("agent-nav:quick-entry-status", handler);
    return () => ipcRenderer.removeListener("agent-nav:quick-entry-status", handler);
  },
  quickEntryClose: (): Promise<void> => ipcRenderer.invoke("agent-nav:quick-close"),
  quickEntryResize: (cardHeight: number): Promise<void> => ipcRenderer.invoke("agent-nav:quick-resize", cardHeight),
  quickEntryFinish: (result: { agentId: string; stay: boolean }): Promise<void> => ipcRenderer.invoke("agent-nav:quick-finish", result),
  quickEntrySwitch: (agentId: string | null): Promise<void> => ipcRenderer.invoke("agent-nav:quick-switch", agentId),
  quickEntryPinned: (pinned: boolean): Promise<void> => ipcRenderer.invoke("agent-nav:quick-pinned", pinned),
  quickEntryOpenInMain: (agentId: string): Promise<void> => ipcRenderer.invoke("agent-nav:quick-open-main", agentId),
  quickEntryHost: (message: unknown): Promise<void> => ipcRenderer.invoke("agent-nav:quick-host", message),
  onQuickEntryShow: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("agent-nav:quick-entry-show", handler);
    return () => ipcRenderer.removeListener("agent-nav:quick-entry-show", handler);
  },
  browserEmulate: (id: number, params: { width: number; height: number; dpr: number; mobile?: boolean; userAgent?: string | null } | null): Promise<void> => ipcRenderer.invoke("agent-nav:browser-emulate", id, params),
});
