import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { EmbedFromHost, EmbedToHost } from "../../shared/embed";
import { activeFrame, bindFrame, dropFrame, dropMissing, frameTitle, showFrame, type Frame } from "./chatState";
import type { Daemon } from "./daemon";
import { daemonMessage, handleHostMessage, themeKind } from "./host";
import { chatHtml, embedUrl } from "./html";
import { launchApp } from "./launch";
import { readSettings } from "./settings";

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

  async openDraft(workspaceId: string) {
    await this.open({ key: this.newKey(), agentId: null, workspaceId, src: this.urlFor({ workspaceId }) });
  }

  current(): Frame | null {
    return activeFrame(this.frames);
  }

  hasSession() {
    return this.frames.length > 0;
  }

  drop(key: string) {
    this.frames = dropFrame(this.frames, key);
    this.afterChange();
  }

  attach(message: EmbedFromHost) {
    const frame = this.current();
    if (!frame) return false;
    this.post({ kind: "relay", frame: frame.key, message });
    if (this.view && !this.view.visible) this.view.show(true);
    return true;
  }

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
    await vscode.commands.executeCommand(`${ChatView.viewType}.focus`);
    this.flushFocus();
  }

  private flushFocus() {
    const frame = this.current();
    if (!this.pendingFocus || !this.ready || !frame) return;
    this.pendingFocus = false;
    this.post({ kind: "relay", frame: frame.key, message: { type: "agent-nav:focus" } });
  }

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
    await handleHostMessage(this.daemon, message, vscode.ViewColumn.Active);
  }

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

  private restoreLast() {
    if (this.restored) return;
    this.restored = true;
    const last = this.context.workspaceState.get<string>(LAST_KEY);
    if (!last || this.frames.length || !this.daemon.agents.some((a) => a.id === last)) return;
    this.frames = [{ key: this.newKey(), agentId: last, workspaceId: null, src: this.urlFor({ agentId: last }) }];
  }

  private markVisibleRead() {
    const agentId = this.current()?.agentId;
    if (!agentId || !this.view?.visible || !vscode.window.state.focused || this.daemon.state !== "online") return;
    const agent = this.daemon.agents.find((a) => a.id === agentId);
    if (agent?.unread && agent.status === "idle") void this.daemon.call("agents.markRead", { agentId: agent.id, read: true }).catch(() => undefined);
  }
}
