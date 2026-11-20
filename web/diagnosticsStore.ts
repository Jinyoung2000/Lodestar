// 서버가 보낸 진단 원본(코드와 source 가 들어 있다). @codemirror/lsp-client 의 serverDiagnostics 는 메시지와 심각도만 남기므로,
// hover 상자의 `ts(6198)` 표시와 quick fix 의 context.diagnostics 를 위해 같은 알림을 먼저 받아 여기에 둔다(처리는 serverDiagnostics 가 이어 한다).

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspRelated = { location: { uri: string; range: LspRange }; message: string };
export type LspDiagnostic = { range: LspRange; message: string; severity?: number; code?: number | string; source?: string; relatedInformation?: LspRelated[] };

const byUri = new Map<string, LspDiagnostic[]>();

// FIX6C: 문제 목록 패널(web/ProblemsPanel.tsx)이 변화를 듣도록 버전과 구독을 둔다.
let version = 0;
const listeners = new Set<() => void>();

export function recordDiagnostics(uri: string, diagnostics: LspDiagnostic[]) {
  byUri.set(uri, diagnostics);
  version++;
  for (const listener of listeners) listener();
}

export const diagnosticsVersion = () => version;

export function subscribeDiagnostics(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// 진단이 하나라도 있는 문서의 URI 와 진단. 서버가 빈 목록으로 지운 문서는 뺀다.
export function allDiagnostics(): [string, LspDiagnostic[]][] {
  return [...byUri].filter(([, list]) => list.length > 0);
}

export function diagnosticsOf(uri: string): LspDiagnostic[] {
  return byUri.get(uri) ?? [];
}

export function diagnosticLabel(diagnostic: LspDiagnostic) {
  if (diagnostic.code === undefined) return null;
  const source = diagnostic.source === "typescript" ? "ts" : (diagnostic.source ?? "");
  return `${source}(${diagnostic.code})`;
}
