import { diagnosticLabel, type LspDiagnostic } from "./diagnosticsStore";

export type ProblemSeverity = "error" | "warning" | "info" | "hint";
export type ProblemRow = { id: string; severity: ProblemSeverity; message: string; label: string | null; line: number; column: number };
export type ProblemFile = { key: string; workspaceId: string; path: string; rows: ProblemRow[]; errors: number; warnings: number };
export type ProblemSource = { workspaceId: string; path: string; diagnostics: LspDiagnostic[] };

export function severityOf(value: number | undefined): ProblemSeverity {
  return value === 2 ? "warning" : value === 3 ? "info" : value === 4 ? "hint" : "error";
}

export function groupProblems(sources: ProblemSource[]): ProblemFile[] {
  const files: ProblemFile[] = [];
  for (const source of sources) {
    if (source.diagnostics.length === 0) continue;
    const rows = source.diagnostics
      .map((d, i): ProblemRow => ({ id: `${i}:${d.range.start.line}:${d.range.start.character}:${d.message}`, severity: severityOf(d.severity), message: d.message, label: diagnosticLabel(d), line: d.range.start.line + 1, column: d.range.start.character + 1 }))
      .sort((a, b) => a.line - b.line || a.column - b.column);
    files.push({ key: `${source.workspaceId}:${source.path}`, workspaceId: source.workspaceId, path: source.path, rows, errors: rows.filter((r) => r.severity === "error").length, warnings: rows.filter((r) => r.severity === "warning").length });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function countProblems(files: ProblemFile[]) {
  return { errors: files.reduce((n, f) => n + f.errors, 0), warnings: files.reduce((n, f) => n + f.warnings, 0), total: files.reduce((n, f) => n + f.rows.length, 0) };
}
