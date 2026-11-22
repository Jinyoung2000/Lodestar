import type { ChangeSet, Text } from "@codemirror/state";
import type { Diagnostic } from "@codemirror/lint";

type Position = { line: number; character: number };
export type LspDiagnostic = { range: { start: Position; end: Position }; severity?: number; message: string };

export type DiagnosticPlugin = {
  syncedDoc: Text;
  unsyncedChanges: ChangeSet;
  fromPosition(position: Position, doc?: Text): number;
};

export function toViewDiagnostics(items: readonly LspDiagnostic[], plugin: DiagnosticPlugin): Diagnostic[] {
  return items.map((item) => ({
    from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
    to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
    severity: severityOf(item.severity ?? 1),
    message: item.message,
  }));
}

const severityOf = (severity: number): Diagnostic["severity"] => (severity === 1 ? "error" : severity === 2 ? "warning" : severity === 3 ? "info" : "hint");
