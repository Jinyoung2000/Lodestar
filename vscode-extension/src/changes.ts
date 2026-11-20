import { basename } from "node:path";
import * as vscode from "vscode";
import type { ChangedFile } from "../../shared/protocol";
import type { Daemon } from "./daemon";

// 세션의 변경 파일을 VS Code 의 diff 에디터로 연다. 왼쪽은 세션 기준 내용(데몬의 git.original), 오른쪽은 지금 디스크의 파일이다.
export const BASE_SCHEME = "lodestar-base";

export class BaseContent implements vscode.TextDocumentContentProvider {
  constructor(private daemon: Daemon) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const agentId = query.get("agent");
    if (query.get("empty") || !agentId) return "";
    const { text } = await this.daemon.call("git.original", { agentId, path: uri.path });
    return text ?? "";
  }
}

export async function openChangedFile(agentId: string, file: string, status?: ChangedFile["status"], column: vscode.ViewColumn = vscode.ViewColumn.Beside) {
  if (!file.startsWith("/")) return;
  const base = vscode.Uri.from({ scheme: BASE_SCHEME, path: file, query: new URLSearchParams({ agent: agentId, ...(status === "A" ? { empty: "1" } : {}) }).toString() });
  const current = status === "D" ? vscode.Uri.from({ scheme: BASE_SCHEME, path: file, query: "empty=1" }) : vscode.Uri.file(file);
  try {
    await vscode.commands.executeCommand("vscode.diff", base, current, `${basename(file)} (Lodestar changes)`, { viewColumn: column, preview: true });
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not open the diff: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 변경 칩: 파일을 알면 바로 diff, 모르면 변경 파일 목록에서 고르게 한다(파일이 하나면 바로 연다).
export async function pickChange(daemon: Daemon, agentId: string, file?: string, column: vscode.ViewColumn = vscode.ViewColumn.Beside) {
  if (file) {
    await openChangedFile(agentId, file, undefined, column);
    return;
  }
  let files: ChangedFile[];
  try {
    files = (await daemon.call("git.changes", { agentId })).files;
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read the changes: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!files.length) {
    void vscode.window.showInformationMessage("This session has no changed files.");
    return;
  }
  const picked =
    files.length === 1
      ? files[0]
      : (await vscode.window.showQuickPick(
          files.map((f) => ({ label: f.rel, description: `${f.status}  +${f.additions} -${f.deletions}`, file: f })),
          { title: "Changed files", placeHolder: "Pick a file to compare with the session base" },
        ))?.file;
  if (picked) await openChangedFile(agentId, picked.path, picked.status, column);
}
