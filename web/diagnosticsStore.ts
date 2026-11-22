
export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspRelated = { location: { uri: string; range: LspRange }; message: string };
export type LspDiagnostic = { range: LspRange; message: string; severity?: number; code?: number | string; source?: string; relatedInformation?: LspRelated[] };

const byUri = new Map<string, LspDiagnostic[]>();

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
