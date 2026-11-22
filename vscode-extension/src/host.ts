import { existsSync } from "node:fs";
import * as vscode from "vscode";
import type { EmbedFromHost, EmbedToHost } from "../../shared/embed";
import { openChangedFile, pickChange } from "./changes";
import type { Daemon, DaemonState } from "./daemon";
import { selectedLines } from "./match";

export function themeKind(): "dark" | "light" {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
}

export function daemonMessage(state: DaemonState, port: number) {
  if (state === "noToken") return "No Lodestar token found. Start Lodestar once so it creates one, or set lodestar.home.";
  if (state === "rejected") return `Lodestar on port ${port} refused the connection. Check lodestar.port and lodestar.home.`;
  return `Lodestar is not running on port ${port}.`;
}

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

export function attachMessage(editor: vscode.TextEditor): Extract<EmbedFromHost, { type: "agent-nav:attach" }> | null {
  const { selection, document } = editor;
  if (selection.isEmpty || document.uri.scheme !== "file") return null;
  const lines = selectedLines((line) => document.lineAt(line).text, selection.start, selection.end);
  return { type: "agent-nav:attach", file: document.uri.fsPath, ...lines };
}
