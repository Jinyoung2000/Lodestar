import type { ChangeSet, Text } from "@codemirror/state";
import type { Diagnostic } from "@codemirror/lint";

// 같은 파일을 두 곳에 열면 보기(EditorView)가 둘이다(web/editorDocs.ts, diff 의 수정본 쪽). 서버가 보내는 진단은 파일 하나에 한 번이므로 보기마다 그려 주어야 두 보기 모두 밑줄이 보인다.
// 이 파일은 DOM 없이 시험하는 순수한 부분: LSP 진단을 보기의 위치로 바꾸기. 파일의 보기 목록은 web/lspWorkspace.ts 의 viewsOf 가 준다.

type Position = { line: number; character: number };
export type LspDiagnostic = { range: { start: Position; end: Position }; severity?: number; message: string };

// 변환에 필요한 LSPPlugin 의 일부
export type DiagnosticPlugin = {
  syncedDoc: Text;
  unsyncedChanges: ChangeSet;
  fromPosition(position: Position, doc?: Text): number;
};

// 서버가 본 글(syncedDoc)의 위치를 이 보기의 지금 글 위치로 옮긴다. 아직 서버에 보내지 않은 편집(unsyncedChanges)만큼 밀린다.
export function toViewDiagnostics(items: readonly LspDiagnostic[], plugin: DiagnosticPlugin): Diagnostic[] {
  return items.map((item) => ({
    from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
    to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
    severity: severityOf(item.severity ?? 1),
    message: item.message,
  }));
}

const severityOf = (severity: number): Diagnostic["severity"] => (severity === 1 ? "error" : severity === 2 ? "warning" : severity === 3 ? "info" : "hint");
