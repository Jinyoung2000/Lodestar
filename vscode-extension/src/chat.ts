import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { EmbedFromHost, EmbedToHost } from "../../shared/embed";
import { activeFrame, bindFrame, dropFrame, dropMissing, frameTitle, showFrame, type Frame } from "./chatState";
import type { Daemon } from "./daemon";
import { daemonMessage, handleHostMessage, themeKind } from "./host";
import { chatHtml, embedUrl } from "./html";
import { launchApp } from "./launch";
import { readSettings } from "./settings";

// 사이드바 Chat 뷰. 한 번에 한 세션을 보이고, 본 적 있는 세션의 화면은 webview 안에 숨겨 둔다(chatState.ts 가 정한 개수까지).
// 화면 목록의 정본은 이 클래스의 frames 다. 뷰가 사라졌다 다시 만들어져도(보조 사이드바로 옮길 때 등) 문서가 ready 를 보내면 같은 목록을 다시 내려 준다.
const LAST_KEY = "lodestar.chat.lastAgent";
const COMMANDS = new Set(["lodestar.newSession"]);

type FromWebview = { kind: "ready" } | { kind: "openApp" } | { kind: "command"; command: string } | { kind: "embed"; frame: string; message: EmbedToHost };

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewType = "lodestar.chat";
  private view: vscode.WebviewView | null = null;
  private ready = false;
  private frames: Frame[] = [];
  private pendingFocus = false;
  private restored = false;
  private keySeed = 0;
  private onBound: (agentId: string) => void = () => undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private daemon: Daemon,
    private log: (line: string) => void,
  ) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatView.viewType, this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.onDidChangeActiveColorTheme(() => this.post({ kind: "relay", message: { type: "agent-nav:theme", theme: themeKind() } })),
      vscode.window.onDidChangeWindowState(() => this.markVisibleRead()),
      daemon.onChange(() => this.onDaemonChange()),
    );
    this.updateContext();
  }

  // 화면이 세션에 묶였을 때(트리가 그 행을 고르도록) 알린다.
  onSessionBound(listener: (agentId: string) => void) {
    this.onBound = listener;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    this.render();
    this.updateHeader();
    this.updateContext();
    view.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(view, message));
    view.onDidChangeVisibility(() => {
      this.updateContext();
      this.markVisibleRead();
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = null;
      this.ready = false;
      this.updateContext();
    });
  }

  async openAgent(agentId: string) {
    await this.open({ key: this.newKey(), agentId, workspaceId: null, src: this.urlFor({ agentId }) });
  }

  // 새 세션 입력창. 같은 폴더의 입력창이 이미 있으면 쓰던 글이 남아 있는 그 화면을 보인다.
  async openDraft(workspaceId: string) {
    await this.open({ key: this.newKey(), agentId: null, workspaceId, src: this.urlFor({ workspaceId }) });
  }

  current(): Frame | null {
    return activeFrame(this.frames);
  }

  hasSession() {
    return this.frames.length > 0;
  }

  // 화면을 지운다(에디터 탭으로 옮겼을 때). 남은 화면 중 가장 최근 것이 보인다.
  drop(key: string) {
    this.frames = dropFrame(this.frames, key);
    this.afterChange();
  }

  // 에디터 선택을 지금 보이는 세션 입력창에 첨부한다.
  attach(message: EmbedFromHost) {
    const frame = this.current();
    if (!frame) return false;
    this.post({ kind: "relay", frame: frame.key, message });
    if (this.view && !this.view.visible) this.view.show(true);
    return true;
  }

  // 포트 설정이 바뀌면 CSP 의 출처와 화면 주소가 달라지므로 문서를 다시 쓴다.
  onSettingsChanged() {
    this.frames = this.frames.map((f) => ({ ...f, src: this.urlFor(f.agentId ? { agentId: f.agentId } : { workspaceId: f.workspaceId ?? "" }) }));
    if (!this.view) return;
    this.ready = false;
    this.render();
  }

  private newKey() {
    return `frame-${++this.keySeed}`;
  }

  private urlFor(target: { agentId: string } | { workspaceId: string }) {
    return embedUrl(readSettings().port, target, themeKind());
  }

  private render() {
    if (!this.view) return;
    const { port } = readSettings();
    this.view.webview.html = chatHtml({ nonce: randomBytes(16).toString("base64url"), origin: `http://127.0.0.1:${port}`, theme: themeKind() });
  }

  private async open(frame: Frame) {
    this.frames = showFrame(this.frames, frame).frames;
    this.pendingFocus = true;
    this.afterChange(true);
    // 뷰가 아직 없거나 접혀 있거나 다른 패널 뒤에 있어도 이 명령이 열어 준다. 문서가 아직 안 떴으면 ready 에서 sync 와 포커스를 이어서 한다.
    await vscode.commands.executeCommand(`${ChatView.viewType}.focus`);
    this.flushFocus();
  }

  private flushFocus() {
    const frame = this.current();
    if (!this.pendingFocus || !this.ready || !frame) return;
    this.pendingFocus = false;
    this.post({ kind: "relay", frame: frame.key, message: { type: "agent-nav:focus" } });
  }

  // 화면 목록이나 보이는 화면이 바뀐 뒤. reveal 이면 트리가 그 세션 행을 고르게 한다(사용자가 연 경우만).
  private afterChange(reveal = false) {
    const frame = this.current();
    void this.context.workspaceState.update(LAST_KEY, frame?.agentId ?? undefined);
    this.updateHeader();
    this.updateContext();
    this.sync();
    if (reveal && frame?.agentId) this.onBound(frame.agentId);
    this.markVisibleRead();
  }

  private sync() {
    this.post({ kind: "frames", frames: this.frames.map(({ key, src }) => ({ key, src })), active: this.current()?.key ?? null });
  }

  private pushDaemon() {
    this.post({ kind: "daemon", online: this.daemon.state === "online", message: daemonMessage(this.daemon.state, readSettings().port) });
  }

  // 문서가 뜨기 전에 보낸 메시지는 잃으므로 ready 이후에만 보낸다. ready 가 오면 목록과 연결 상태를 통째로 내려 준다.
  private post(message: object) {
    if (!this.view || !this.ready) return;
    void this.view.webview.postMessage(message);
  }

  private updateHeader() {
    if (this.view) this.view.description = frameTitle(this.current(), (id) => this.daemon.agents.find((a) => a.id === id)?.title);
  }

  private updateContext() {
    void vscode.commands.executeCommand("setContext", "lodestar.chatHasSession", this.frames.length > 0);
  }

  private async onMessage(view: vscode.WebviewView, message: FromWebview) {
    if (this.view !== view) return;
    switch (message.kind) {
      case "ready":
        this.ready = true;
        this.sync();
        this.pushDaemon();
        this.flushFocus();
        return;
      case "openApp":
        launchApp(this.log);
        return;
      case "command":
        if (COMMANDS.has(message.command)) await vscode.commands.executeCommand(message.command);
        return;
      case "embed":
        await this.onEmbed(message.frame, message.message);
        return;
    }
  }

  private async onEmbed(key: string, message: EmbedToHost) {
    if (!this.frames.some((f) => f.key === key)) return;
    if (message.type === "agent-nav:session") {
      this.frames = bindFrame(this.frames, key, message.agentId, this.urlFor({ agentId: message.agentId })).frames;
      this.afterChange(true);
      return;
    }
    // 사이드바는 에디터 그룹이 아니라서 파일과 diff 는 지금 에디터 그룹에 연다.
    await handleHostMessage(this.daemon, message, vscode.ViewColumn.Active);
  }

  // 데몬 이벤트는 대화 중 계속 오므로, 화면 목록이 바뀐 때만 sync 를 다시 보낸다.
  private onDaemonChange() {
    this.pushDaemon();
    const before = this.frames;
    if (this.daemon.loaded) this.restoreLast();
    if (this.daemon.state === "online" && this.daemon.loaded) this.frames = dropMissing(this.frames, (id) => this.daemon.agents.some((a) => a.id === id)).frames;
    if (this.frames.length !== before.length || this.frames.at(-1) !== before.at(-1)) this.afterChange();
    else {
      this.updateHeader();
      this.markVisibleRead();
    }
  }

  // 창을 다시 읽은 뒤 처음 목록을 받으면 마지막으로 보던 세션을 사이드바에 올려 둔다(포커스는 가져오지 않는다).
  private restoreLast() {
    if (this.restored) return;
    this.restored = true;
    const last = this.context.workspaceState.get<string>(LAST_KEY);
    if (!last || this.frames.length || !this.daemon.agents.some((a) => a.id === last)) return;
    this.frames = [{ key: this.newKey(), agentId: last, workspaceId: null, src: this.urlFor({ agentId: last }) }];
  }

  // 보고 있는 세션은 읽음으로 둔다(Lodestar 앱이 열린 세션을 읽음으로 두는 것과 같다).
  private markVisibleRead() {
    const agentId = this.current()?.agentId;
    if (!agentId || !this.view?.visible || !vscode.window.state.focused || this.daemon.state !== "online") return;
    const agent = this.daemon.agents.find((a) => a.id === agentId);
    if (agent?.unread && agent.status === "idle") void this.daemon.call("agents.markRead", { agentId: agent.id, read: true }).catch(() => undefined);
  }
}
