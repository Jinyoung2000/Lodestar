import * as vscode from "vscode";
import { BASE_SCHEME, BaseContent } from "./changes";
import { ChatView } from "./chat";
import { pickAttachTarget } from "./chatState";
import { Daemon } from "./daemon";
import { attachMessage } from "./host";
import { launchApp } from "./launch";
import { workspaceForFolder } from "./match";
import { Panels } from "./panels";
import { readOpenIn, readSettings } from "./settings";
import { openFolders, realpath, SessionsView, type Node } from "./tree";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Lodestar");
  const log = (line: string) => output.appendLine(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const daemon = new Daemon(readSettings, log);
  const view = new SessionsView(daemon);
  const panels = new Panels(context, daemon, log);
  const chat = new ChatView(context, daemon, log);
  panels.onSessionBound((agentId) => void view.reveal(agentId));
  chat.onSessionBound((agentId) => void view.reveal(agentId));

  // 행 메뉴에서는 그 행이 인자로 오고, 팔레트와 단축키에서는 트리에서 고른 행을 쓴다.
  const agentOf = (node?: Node) => {
    const target = node ?? view.view.selection[0];
    return target?.kind === "session" ? target.agent : undefined;
  };

  context.subscriptions.push(
    output,
    { dispose: () => daemon.stop() },
    view,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContent(daemon)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("lodestar.port") || event.affectsConfiguration("lodestar.home")) daemon.reconnect();
      if (event.affectsConfiguration("lodestar.port")) chat.onSettingsChanged();
    }),
    vscode.commands.registerCommand("lodestar.refresh", () => daemon.reconnect()),
    vscode.commands.registerCommand("lodestar.openApp", () => launchApp(log)),
    // 설정 lodestar.openSessionIn 이 정한 곳에 연다(기본은 사이드바 Chat 뷰).
    vscode.commands.registerCommand("lodestar.openSession", async (node?: Node) => {
      const agent = agentOf(node);
      if (!agent) return;
      if (readOpenIn() === "editor") panels.open(agent.id);
      else await chat.openAgent(agent.id);
    }),
    // 행 메뉴에서는 그 행의 세션을, Chat 뷰 머리에서는 지금 보는 화면을 에디터 탭으로 옮긴다. 같은 세션 입력창이 둘이 되지 않게 사이드바 쪽 화면은 지운다.
    vscode.commands.registerCommand("lodestar.openInEditor", (node?: Node) => {
      // view/title 에서 오면 인자가 트리 행이 아닐 수 있으므로 행(kind: session)일 때만 행으로 본다.
      const fromTree = node?.kind === "session" ? node : undefined;
      const fromChat = fromTree ? null : chat.current();
      const agentId = fromTree?.agent.id ?? fromChat?.agentId ?? agentOf()?.id;
      if (agentId) panels.open(agentId);
      else if (fromChat?.workspaceId) panels.openDraft(fromChat.workspaceId);
      else return;
      const shown = chat.current();
      if (shown && (shown === fromChat || (agentId && shown.agentId === agentId))) chat.drop(shown.key);
    }),
    vscode.commands.registerCommand("lodestar.showSessions", () => vscode.commands.executeCommand("lodestar.sessions.focus")),
    vscode.commands.registerCommand("lodestar.openInApp", async (node?: Node) => {
      const agent = agentOf(node);
      if (!agent) return;
      // 떠 있는 Lodestar 창이 그 세션을 보이게 하고, 앱을 앞으로 가져온다. 구버전 데몬은 이 요청을 모른다.
      await daemon.call("app.showAgent", { agentId: agent.id }).catch((error: Error) => log(`app.showAgent failed: ${error.message}`));
      launchApp(log);
    }),
    vscode.commands.registerCommand("lodestar.rename", async (node?: Node) => {
      const agent = agentOf(node);
      if (!agent) return;
      const title = await vscode.window.showInputBox({ title: "Rename Session", value: agent.title, validateInput: (value) => (value.trim() ? undefined : "Enter a name.") });
      if (title?.trim() && title.trim() !== agent.title) await run(() => daemon.call("agents.rename", { agentId: agent.id, title: title.trim() }));
    }),
    vscode.commands.registerCommand("lodestar.markDone", (node?: Node) => setDone(daemon, agentOf(node), true)),
    vscode.commands.registerCommand("lodestar.markNotDone", (node?: Node) => setDone(daemon, agentOf(node), false)),
    vscode.commands.registerCommand("lodestar.newSession", async () => {
      const workspaceId = await workspaceFor(daemon);
      if (!workspaceId) return;
      if (readOpenIn() === "editor") panels.openDraft(workspaceId);
      else await chat.openDraft(workspaceId);
    }),
    vscode.commands.registerCommand("lodestar.addSelection", () => {
      const editor = vscode.window.activeTextEditor;
      const message = editor && attachMessage(editor);
      if (!message) return;
      const target = pickAttachTarget({ openIn: readOpenIn(), panelFocused: panels.hasFocused(), panelsOpen: panels.hasOpen(), sidebarHasSession: chat.hasSession() });
      if (target === "sidebar") chat.attach(message);
      else if (target === "panel") panels.attachSelection(message);
      else void vscode.window.showInformationMessage("Open an Lodestar session first, then add the selection.");
    }),
  );
  daemon.start();
}

export function deactivate() {}

async function setDone(daemon: Daemon, agent: { id: string } | undefined, done: boolean) {
  if (agent) await run(() => daemon.call("agents.setDone", { agentId: agent.id, done }));
}

async function run(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

// New Session 을 열 폴더의 워크스페이스 id. 폴더가 여럿이면 고르게 하고, Lodestar 에 등록돼 있지 않으면 등록한다(새 세션을 만들려는 명시적 동작이다).
async function workspaceFor(daemon: Daemon): Promise<string | null> {
  if (daemon.state !== "online") {
    void vscode.window.showWarningMessage("Lodestar is not running.", "Open Lodestar").then((pick) => pick && vscode.commands.executeCommand("lodestar.openApp"));
    return null;
  }
  const folders = openFolders();
  if (!folders.length) {
    void vscode.window.showInformationMessage("Open a folder to start an Lodestar session.");
    return null;
  }
  const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders, { title: "Folder for the new session" })) ?? null;
  if (!folder) return null;
  const known = workspaceForFolder(folder, daemon.workspaces, realpath);
  if (known) return known.id;
  try {
    return (await daemon.call("workspaces.add", { dir: folder })).id;
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return null;
  }
}
