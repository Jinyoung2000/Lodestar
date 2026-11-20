import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { EmbedFromHost, EmbedToHost } from "../../shared/embed";
import type { Daemon } from "./daemon";
import { daemonMessage, handleHostMessage, themeKind } from "./host";
import { embedUrl, panelHtml } from "./html";
import { launchApp } from "./launch";
import { readSettings } from "./settings";

const VIEW_TYPE = "lodestar.session";

// 세션 패널은 agentId 당 하나다. 새 세션 입력창 패널은 첫 메시지를 보내 세션이 생기면 그 세션 패널이 된다.
type Entry = { panel: vscode.WebviewPanel; agentId: string | null; workspaceId: string | null };
type PanelState = { agentId?: string; title?: string };
type FromWebview = EmbedToHost | { type: "ext:openApp" };

export class Panels {
  private entries = new Set<Entry>();
  private lastActive: Entry | null = null;
  private onBound: (agentId: string) => void = () => undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private daemon: Daemon,
    private log: (line: string) => void,
  ) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (panel, state: PanelState | undefined) => this.restore(panel, state) }),
      vscode.window.onDidChangeActiveColorTheme(() => this.broadcast({ type: "agent-nav:theme", theme: themeKind() })),
      vscode.window.onDidChangeWindowState(() => this.markVisibleRead()),
      daemon.onChange(() => this.onDaemonChange()),
    );
  }

  // 새 세션이 패널에 묶였을 때(트리가 그 행을 고르도록) 알린다.
  onSessionBound(listener: (agentId: string) => void) {
    this.onBound = listener;
  }

  open(agentId: string) {
    const existing = [...this.entries].find((e) => e.agentId === agentId);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }
    const title = this.daemon.agents.find((a) => a.id === agentId)?.title ?? "Lodestar";
    this.attach(vscode.window.createWebviewPanel(VIEW_TYPE, title, vscode.ViewColumn.Active, panelOptions()), { agentId, workspaceId: null });
  }

  openDraft(workspaceId: string) {
    this.attach(vscode.window.createWebviewPanel(VIEW_TYPE, "New Session", vscode.ViewColumn.Active, panelOptions()), { agentId: null, workspaceId });
  }

  hasOpen() {
    return this.entries.size > 0;
  }

  hasFocused() {
    return [...this.entries].some((e) => e.panel.active);
  }

  // 지금 쓰는 패널(가장 마지막에 활성이었던 패널)에 에디터 선택을 첨부한다.
  attachSelection(message: EmbedFromHost) {
    const entry = this.current();
    if (!entry) return false;
    this.post(entry, message);
    if (!entry.panel.visible) entry.panel.reveal(undefined, true);
    return true;
  }

  private current(): Entry | null {
    const active = [...this.entries].find((e) => e.panel.active);
    if (active) return active;
    if (this.lastActive && this.entries.has(this.lastActive)) return this.lastActive;
    return [...this.entries].at(-1) ?? null;
  }

  private restore(panel: vscode.WebviewPanel, state: PanelState | undefined) {
    if (!state?.agentId) {
      panel.dispose();
      return;
    }
    panel.title = state.title ?? "Lodestar";
    this.attach(panel, { agentId: state.agentId, workspaceId: null });
  }

  private attach(panel: vscode.WebviewPanel, init: { agentId: string | null; workspaceId: string | null }) {
    const entry: Entry = { panel, ...init };
    this.entries.add(entry);
    panel.iconPath = { light: vscode.Uri.joinPath(this.context.extensionUri, "media", "tab-light.svg"), dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "tab-dark.svg") };
    panel.webview.options = { enableScripts: true };
    this.render(entry);
    this.pushDaemon(entry);
    if (entry.agentId) this.bind(entry);
    panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(entry, message));
    panel.onDidChangeViewState(() => {
      if (panel.active) this.lastActive = entry;
      this.markVisibleRead();
    });
    panel.onDidDispose(() => {
      this.entries.delete(entry);
      if (this.lastActive === entry) this.lastActive = null;
    });
    if (panel.active) this.lastActive = entry;
  }

  private render(entry: Entry) {
    const { port } = readSettings();
    const target = entry.agentId ? { agentId: entry.agentId } : { workspaceId: entry.workspaceId ?? "" };
    entry.panel.webview.html = panelHtml({ nonce: randomBytes(16).toString("base64url"), origin: `http://127.0.0.1:${port}`, src: embedUrl(port, target, themeKind()), theme: themeKind() });
  }

  // 새 세션이 패널에 묶이면 webview 에 복원 상태를 맡긴다(창을 다시 읽어도 같은 세션 패널이 돌아온다).
  private bind(entry: Entry) {
    if (!entry.agentId) return;
    const title = this.daemon.agents.find((a) => a.id === entry.agentId)?.title ?? entry.panel.title;
    void entry.panel.webview.postMessage({ kind: "bind", state: { agentId: entry.agentId, title } satisfies PanelState });
  }

  private async onMessage(entry: Entry, message: FromWebview) {
    if (await handleHostMessage(this.daemon, message as EmbedToHost, vscode.ViewColumn.Beside)) return;
    switch (message.type) {
      case "agent-nav:session": {
        const duplicate = [...this.entries].find((e) => e !== entry && e.agentId === message.agentId);
        entry.agentId = message.agentId;
        entry.workspaceId = null;
        this.onDaemonChange();
        this.bind(entry);
        this.onBound(message.agentId);
        if (duplicate) duplicate.panel.dispose();
        return;
      }
      case "ext:openApp":
        launchApp(this.log);
        return;
      case "agent-nav:ready":
        return;
    }
  }

  private post(entry: Entry, message: EmbedFromHost) {
    void entry.panel.webview.postMessage({ kind: "relay", message });
  }

  private broadcast(message: EmbedFromHost) {
    for (const entry of this.entries) this.post(entry, message);
  }

  private onDaemonChange() {
    for (const entry of [...this.entries]) {
      this.pushDaemon(entry);
      if (!entry.agentId) continue;
      const agent = this.daemon.agents.find((a) => a.id === entry.agentId);
      if (agent) {
        if (entry.panel.title !== agent.title) entry.panel.title = agent.title;
      } else if (this.daemon.state === "online" && this.daemon.loaded) {
        entry.panel.dispose();
      }
    }
    this.markVisibleRead();
  }

  private pushDaemon(entry: Entry) {
    void entry.panel.webview.postMessage({ kind: "daemon", online: this.daemon.state === "online", message: daemonMessage(this.daemon.state, readSettings().port) });
  }

  // 보고 있는 패널의 세션은 읽음으로 둔다(Lodestar 앱이 열린 세션을 읽음으로 두는 것과 같다).
  private markVisibleRead() {
    if (!vscode.window.state.focused || this.daemon.state !== "online") return;
    for (const entry of this.entries) {
      if (!entry.agentId || !entry.panel.visible) continue;
      const agent = this.daemon.agents.find((a) => a.id === entry.agentId);
      if (agent?.unread && agent.status === "idle") void this.daemon.call("agents.markRead", { agentId: agent.id, read: true }).catch(() => undefined);
    }
  }
}

function panelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return { enableScripts: true, retainContextWhenHidden: true };
}
