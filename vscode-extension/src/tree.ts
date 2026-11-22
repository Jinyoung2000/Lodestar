import { realpathSync } from "node:fs";
import * as vscode from "vscode";
import type { Agent } from "../../shared/protocol";
import type { Daemon } from "./daemon";
import { attentionCount, describeSession, matchSessions, sortSessions, statusOf, type SessionStatus } from "./match";

export type Node = { kind: "session"; agent: Agent } | { kind: "done"; agents: Agent[] };

const TICK_MS = 30_000;

export class SessionsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly view: vscode.TreeView<Node>;
  private timer: NodeJS.Timeout;
  private subscriptions: vscode.Disposable[];

  constructor(private daemon: Daemon) {
    this.view = vscode.window.createTreeView("lodestar.sessions", { treeDataProvider: this, showCollapseAll: false });
    this.timer = setInterval(() => this.refresh(), TICK_MS);
    this.subscriptions = [this.view, this.emitter, this.view.onDidChangeSelection((event) => void vscode.commands.executeCommand("setContext", "lodestar.hasSelection", event.selection.length > 0)), daemon.onChange(() => this.refresh()), vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())];
    this.updateContext();
  }

  dispose() {
    clearInterval(this.timer);
    for (const item of this.subscriptions) item.dispose();
  }

  refresh() {
    this.updateContext();
    this.emitter.fire(undefined);
  }

  matched(): Agent[] {
    return matchSessions(openFolders(), this.daemon.workspaces, this.daemon.agents, realpath);
  }

  find(agentId: string): Agent | undefined {
    return this.matched().find((a) => a.id === agentId);
  }

  async reveal(agentId: string) {
    const agent = this.find(agentId);
    if (agent && !agent.done && this.view.visible) await this.view.reveal({ kind: "session", agent }, { select: true, focus: false }).then(undefined, () => undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === "done") return node.agents.map((agent) => ({ kind: "session", agent }));
    if (node) return [];
    if (this.daemon.state !== "online") return [];
    const sessions = this.matched();
    const active = sortSessions(sessions.filter((a) => !a.done)).map((agent): Node => ({ kind: "session", agent }));
    const done = sortSessions(sessions.filter((a) => a.done));
    return done.length ? [...active, { kind: "done", agents: done }] : active;
  }

  getParent(node: Node): Node | undefined {
    return node.kind === "session" && node.agent.done ? { kind: "done", agents: sortSessions(this.matched().filter((a) => a.done)) } : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "done") {
      const item = new vscode.TreeItem("Done", vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(node.agents.length);
      item.id = "done";
      return item;
    }
    const { agent } = node;
    const status = statusOf(agent);
    const item = new vscode.TreeItem(agent.title, vscode.TreeItemCollapsibleState.None);
    item.id = agent.id;
    item.description = describeSession(agent, Date.now());
    item.iconPath = iconOf(status);
    item.contextValue = agent.done ? "session.done" : "session";
    item.tooltip = tooltipOf(agent, status);
    item.command = { command: "lodestar.openSession", title: "Open", arguments: [node] };
    return item;
  }

  private updateContext() {
    const folders = openFolders();
    const matched = folders.length ? this.matched() : [];
    const state = !folders.length ? "noFolder" : this.daemon.state !== "online" ? this.daemon.state : matched.length ? "ready" : "empty";
    void vscode.commands.executeCommand("setContext", "lodestar.state", state);
    const count = this.daemon.state === "online" ? attentionCount(matched) : 0;
    this.view.badge = count ? { value: count, tooltip: `${count} session${count === 1 ? "" : "s"} need attention` } : undefined;
  }
}

export function openFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => realpath(f.uri.fsPath));
}

export function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function iconOf(status: SessionStatus): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"));
    case "waiting":
      return new vscode.ThemeIcon("bell", new vscode.ThemeColor("charts.yellow"));
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    case "unread":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.blue"));
    case "read":
      return new vscode.ThemeIcon("circle-small-filled", new vscode.ThemeColor("disabledForeground"));
  }
}

function tooltipOf(agent: Agent, status: SessionStatus): vscode.MarkdownString {
  const label = { running: "Working", waiting: "Input needed", error: "Error", unread: "Unread", read: "Read" }[status];
  const tip = new vscode.MarkdownString(undefined, true);
  tip.appendText(`${agent.title}\n${label}`);
  if (agent.worktree) tip.appendText(`\nBranch: ${agent.worktree.branch}`);
  tip.appendText(`\n${agent.cwd}`);
  return tip;
}
