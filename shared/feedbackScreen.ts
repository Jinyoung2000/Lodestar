// 피드백을 보낼 때의 화면 상태를 모으고 프롬프트 줄로 바꾼다. 스토어를 직접 읽지 않고 필요한 값만 받아서 시험할 수 있다.
import type { ScreenContext } from "./protocol";

export type ScreenInput = {
  centerView: "sessions" | "board" | "inbox" | "pr" | "improvements" | "notion" | "notes" | "skills";
  overlay: { kind: string } | null;
  panes: { id: string; kind: "agent" | "draft"; agentId?: string }[];
  activePaneId: string;
  agents: { id: string; title: string }[];
  layoutMode: string;
  sidebarOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  bottomTab: string;
  activeTabKey: string | null;
  tabs: { key: string; kind: string; path?: string }[];
  theme: string;
  width: number;
  height: number;
};

const CENTER: Record<ScreenInput["centerView"], string> = { sessions: "Sessions", board: "Board", inbox: "Inbox", pr: "Pull requests", improvements: "Improvements", notion: "Notion", notes: "Notes", skills: "Skills" };
const OVERLAY: Record<string, string> = {
  quickOpen: "Quick open",
  symbols: "Go to symbol",
  models: "Model picker",
  effort: "Effort picker",
  sessions: "Session search",
  commands: "Command palette",
  status: "Settings",
  browserHistory: "Browser history",
  sitePermissions: "Site permissions",
  devicePresets: "Device presets",
  userAgent: "User agent picker",
  device: "Device picker",
  choice: "Choice dialog",
};
const FIXED_TAB: Record<string, string> = { changes: "Changes", card: "Board card", inbox: "Inbox" };

export function describeScreen(input: ScreenInput): ScreenContext {
  const pane = input.panes.find((p) => p.id === input.activePaneId) ?? input.panes[0];
  const title = pane?.kind === "agent" ? input.agents.find((a) => a.id === pane.agentId)?.title : undefined;
  const tab = input.activeTabKey ? input.tabs.find((t) => t.key === input.activeTabKey) : undefined;
  const rightName = input.activeTabKey ? (FIXED_TAB[input.activeTabKey] ?? (tab ? (tab.path ? `${tab.kind} ${tab.path.slice(tab.path.lastIndexOf("/") + 1)}` : tab.kind) : input.activeTabKey)) : "Panel";
  return {
    view: CENTER[input.centerView] ?? input.centerView,
    overlay: input.overlay ? (OVERLAY[input.overlay.kind] ?? input.overlay.kind) : null,
    activePane: pane ? (pane.kind === "draft" ? "New session" : (title ?? "Session")) : "none",
    paneCount: input.panes.length,
    layout: input.layoutMode === "editor" ? "Editor (chat floats at the bottom right)" : "Chat",
    sidebar: input.sidebarOpen,
    rightPanel: input.rightOpen ? rightName : null,
    bottomPanel: input.bottomOpen ? input.bottomTab : null,
    theme: input.theme,
    width: Math.round(input.width),
    height: Math.round(input.height),
  };
}

export function screenLines(screen: ScreenContext) {
  return [
    `- Open screen: ${screen.view}${screen.overlay ? `, with ${screen.overlay} open on top` : ""}`,
    `- Active chat pane: ${screen.activePane} (${screen.paneCount} pane${screen.paneCount === 1 ? "" : "s"} open)`,
    `- Layout: ${screen.layout}; sidebar ${screen.sidebar ? "open" : "closed"}; right panel ${screen.rightPanel ?? "closed"}; bottom panel ${screen.bottomPanel ?? "closed"}`,
    `- Theme: ${screen.theme}; window ${screen.width}x${screen.height} CSS px`,
  ];
}
