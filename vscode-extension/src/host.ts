import { existsSync } from "node:fs";
import * as vscode from "vscode";
import type { EmbedFromHost, EmbedToHost } from "../../shared/embed";
import { openChangedFile, pickChange } from "./changes";
import type { Daemon, DaemonState } from "./daemon";
import { selectedLines } from "./match";

// 에디터 탭 패널(panels.ts)과 사이드바 Chat 뷰(chat.ts)가 같이 쓰는 것.

// 고대비 라이트도 밝은 테마로 본다.
export function themeKind(): "dark" | "light" {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
}

export function daemonMessage(state: DaemonState, port: number) {
  if (state === "noToken") return "No Lodestar token found. Start Lodestar once so it creates one, or set lodestar.home.";
  if (state === "rejected") return `Lodestar on port ${port} refused the connection. Check lodestar.port and lodestar.home.`;
  return `Lodestar is not running on port ${port}.`;
}

// 화면이 보낸 메시지 중 VS Code 를 여는 것들. 처리했으면 true. column 은 파일과 diff 를 여는 에디터 그룹이다(패널은 옆, 사이드바는 지금 그룹).
export async function handleHostMessage(daemon: Daemon, message: EmbedToHost, column: vscode.ViewColumn): Promise<boolean> {
  switch (message.type) {
    case "agent-nav:openFile":
      await openEditorFile(message.file, message.line, message.column, column);
      return true;
    case "agent-nav:openDiff":
      await openChangedFile(message.agentId, message.file, undefined, column);
      return true;
    case "agent-nav:openChanges":
      await pickChange(daemon, message.agentId, message.file, column);
      return true;
    case "agent-nav:openExternal":
      if (/^https?:\/\//.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
      return true;
    default:
      return false;
  }
}

async function openEditorFile(file: string, line: number | undefined, column: number | undefined, viewColumn: vscode.ViewColumn) {
  if (!file.startsWith("/") || file.includes("\0")) return;
  if (!existsSync(file)) {
    void vscode.window.showWarningMessage(`File not found: ${file}`);
    return;
  }
  const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
  await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn, selection: new vscode.Range(position, position), preview: true });
}

// 에디터 선택을 화면에 첨부하는 메시지. 선택이 없거나 file 이 아닌 문서면 null.
export function attachMessage(editor: vscode.TextEditor): Extract<EmbedFromHost, { type: "agent-nav:attach" }> | null {
  const { selection, document } = editor;
  if (selection.isEmpty || document.uri.scheme !== "file") return null;
  const lines = selectedLines((line) => document.lineAt(line).text, selection.start, selection.end);
  return { type: "agent-nav:attach", file: document.uri.fsPath, ...lines };
}
