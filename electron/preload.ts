import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { QuickEntryConfig, QuickShortcutStatus } from "../shared/quickEntry";

// 페이지가 쓸 수 있는 네이티브 기능: 화면의 한 영역을 PNG(base64)로 받기, OS 알림, Browser 탭 guest 조작. 창을 앞으로 가져오지 않는다.
export type CaptureRect = { x: number; y: number; width: number; height: number };

export type NotifyPayload = { agentId: string; kind: "response" | "approval"; title: string; body: string; itemId?: string; actionLabel?: string };

contextBridge.exposeInMainWorld("agentNavNative", {
  captureElement: (rect: CaptureRect): Promise<string | null> => ipcRenderer.invoke("agent-nav:capture", rect),
  // OS 알림. 창이 포커스를 갖고 있으면 메인이 띄우지 않고 false 를 돌려준다.
  notify: (payload: NotifyPayload): Promise<boolean> => ipcRenderer.invoke("agent-nav:notify", payload),
  clearNotification: (agentId: string): Promise<void> => ipcRenderer.invoke("agent-nav:notify-clear", agentId),
  // Dock 배지: 사람이 봐야 하는 세션 수(0 이면 지운다). 화면이 수를 정하고 메인이 달기만 한다.
  setBadgeCount: (count: number): Promise<void> => ipcRenderer.invoke("agent-nav:badge", count),
  // Browser 탭 guest 조작. id 는 <webview> 의 getWebContentsId() 이고, 메인이 그것이 이 창의 webview 인지 확인한다.
  // mode: element(요소 하나), comment(요소 댓글, 댓글마다 onBrowserComment), area(영역 스크린샷). image 는 element 의 이미지도 받을지.
  browserPick: (id: number, mode: "element" | "comment" | "area", options?: { image?: boolean }) => ipcRenderer.invoke("agent-nav:browser-pick", id, mode, options),
  onBrowserComment: (listener: (payload: { id: number; item: unknown }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: number; item: unknown }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-comment", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-comment", handler);
  },
  browserConsole: (id: number) => ipcRenderer.invoke("agent-nav:browser-console", id),
  // 에이전트의 Browser 도구 한 번을 이 창의 webview 에서 실행한다.
  browserTool: (id: number, tool: string, args: Record<string, unknown>) => ipcRenderer.invoke("agent-nav:browser-tool", id, tool, args),
  // 사이트 권한: 묻는 요청은 메인이 onBrowserPermission 으로 알리고 화면이 답한다. get 과 set 은 Site Permissions 선택창이 쓴다.
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
  // 공유 중인 탭의 페이지가 띄운 대화상자(없어지면 dialog 가 null)와 그 답
  onBrowserDialog: (listener: (payload: { id: number; dialog: { type: string; message: string; defaultPrompt: string } | null }) => void): (() => void) => {
    const handler = (_event: unknown, payload: { id: number; dialog: { type: string; message: string; defaultPrompt: string } | null }) => listener(payload);
    ipcRenderer.on("agent-nav:browser-dialog", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-dialog", handler);
  },
  browserDialogAnswer: (id: number, accept: boolean, text?: string): Promise<void> => ipcRenderer.invoke("agent-nav:browser-dialog-answer", id, accept, text),
  // 댓글 핀 미리보기의 X 로 지운 댓글
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
  // 기기 선택창: 메인이 요청(와 갱신)을 알리고 화면이 고른 기기(취소는 null)로 답한다.
  onBrowserDevice: (listener: (request: { requestId: string; origin: string; deviceType: string; devices: { deviceId: string; label: string; detail?: string }[] }) => void): (() => void) => {
    const handler = (_event: unknown, request: Parameters<typeof listener>[0]) => listener(request);
    ipcRenderer.on("agent-nav:browser-device", handler);
    return () => ipcRenderer.removeListener("agent-nav:browser-device", handler);
  },
  browserDeviceAnswer: (requestId: string, deviceId: string | null): Promise<void> => ipcRenderer.invoke("agent-nav:browser-device-answer", requestId, deviceId),
  // 데몬이 재시작하면 메인이 새 데몬이 응답한 뒤에 창을 직접 다시 읽는다. 이 값이 없는 옛 메인이면 화면이 스스로 기다렸다가 읽는다(web/store.ts).
  readsWindowAfterDaemonRestart: true,
  // FILEATTACH: 끌어다 놓거나 고른 File 의 디스크 경로(복사 없이 에이전트에 넘긴다). 디스크에 없는 File(클립보드 바이트, 브라우저에서 끌어온 것)은 빈 문자열이다.
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  // Developer: Reload Window, Restart Daemon. restartDaemon 은 이 앱이 데몬을 띄웠을 때만 true 를 돌려준다.
  reloadWindow: (): Promise<void> => ipcRenderer.invoke("agent-nav:reload-window"),
  restartDaemon: (): Promise<boolean | "deferred"> => ipcRenderer.invoke("agent-nav:restart-daemon"),
  // 데몬이 예상 없이 죽었을 때 앱이 자동으로 다시 띄우는 중인지(restarting) 포기했는지(stopped). 알림은 바뀔 때마다 온다.
  daemonState: (): Promise<{ state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number }> => ipcRenderer.invoke("agent-nav:daemon-state"),
  onDaemonState: (listener: (state: { state: "running" | "restarting" | "stopped"; attempt: number; maxAttempts: number }) => void): (() => void) => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("agent-nav:daemon-state", handler);
    return () => ipcRenderer.removeListener("agent-nav:daemon-state", handler);
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("agent-nav:pick-folder"),
  windowZoom: (action: "in" | "out" | "reset"): Promise<number> => ipcRenderer.invoke("agent-nav:zoom", action),
  // 여러 창: 새 창 열기(⇧⌘N), 이 창 닫기(⇧⌘W), 이 창 칸에 열린 세션 알리기(알림을 누르면 그 세션이 열린 창으로 간다), 살아 있는 창 id 목록과 그 변화(닫힌 창의 저장본 정리용)
  newWindow: (): Promise<void> => ipcRenderer.invoke("agent-nav:new-window"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("agent-nav:close-window"),
  setOpenAgents: (agentIds: string[]): Promise<void> => ipcRenderer.invoke("agent-nav:open-agents", agentIds),
  windowIds: (): Promise<string[]> => ipcRenderer.invoke("agent-nav:window-ids"),
  onWindowsChanged: (listener: (ids: string[]) => void): (() => void) => {
    const handler = (_event: unknown, ids: string[]) => listener(ids);
    ipcRenderer.on("agent-nav:windows-changed", handler);
    return () => ipcRenderer.removeListener("agent-nav:windows-changed", handler);
  },
  // QUICKENTRY: 전역 빠른 입력창. configure, status, onQuickEntryStatus 는 메인 창(Settings 와 단축키 등록)이, close, resize, finish, onQuickEntryShow 는 빠른 입력창 페이지가 쓴다. 메인이 보낸 쪽만 받아 준다.
  quickEntryConfigure: (config: QuickEntryConfig): Promise<QuickShortcutStatus> => ipcRenderer.invoke("agent-nav:quick-configure", config),
  quickEntryStatus: (): Promise<QuickShortcutStatus> => ipcRenderer.invoke("agent-nav:quick-status"),
  onQuickEntryStatus: (listener: (status: QuickShortcutStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: QuickShortcutStatus) => listener(status);
    ipcRenderer.on("agent-nav:quick-entry-status", handler);
    return () => ipcRenderer.removeListener("agent-nav:quick-entry-status", handler);
  },
  quickEntryClose: (): Promise<void> => ipcRenderer.invoke("agent-nav:quick-close"),
  quickEntryResize: (cardHeight: number): Promise<void> => ipcRenderer.invoke("agent-nav:quick-resize", cardHeight),
  // 런처에서 보냈다. stay 가 아니면 패널이 그 자리에서 대화로 커지고, stay(⌘Enter)면 대화를 묶고 숨긴다.
  quickEntryFinish: (result: { agentId: string; stay: boolean }): Promise<void> => ipcRenderer.invoke("agent-nav:quick-finish", result),
  // MINICHAT: 대화 머리가 쓴다. switch 는 세션 바꾸기(null 이면 새 미니 대화), pinned 는 핀 상태 알림, openInMain 은 Lodestar 에서 열기, host 는 대화 안의 파일, 링크 클릭.
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
