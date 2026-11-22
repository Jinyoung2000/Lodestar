import { replacementInContext, type ReplaceFileRequest, type ReplaceQuery } from "../shared/searchReplace";
import type { SearchSettings } from "../shared/searchSettings";
import { effectiveMatchCase, type SearchViewOptions } from "./searchViewModel";
import type { SearchHit } from "./searchTree";

export const replaceShown = (view: Pick<SearchViewOptions, "showReplace">) => view.showReplace;

export const replaceActiveOf = (view: Pick<SearchViewOptions, "showReplace" | "replaceText">, settings: Pick<SearchSettings, "useReplacePreview">) => view.showReplace && view.replaceText !== "" && settings.useReplacePreview;

export const matchTextOf = (hit: SearchHit) => hit.text.slice(hit.start - hit.textOffset, hit.end - hit.textOffset);

export const replaceQueryOf = (view: Pick<SearchViewOptions, "query" | "regex" | "matchCase" | "wholeWord">, smartCase: boolean): ReplaceQuery => ({
  pattern: view.query,
  isRegex: view.regex,
  matchCase: effectiveMatchCase(view, smartCase),
  wholeWord: view.wholeWord,
});

export function replacementOf(hit: SearchHit, view: Pick<SearchViewOptions, "query" | "regex" | "matchCase" | "wholeWord" | "replaceText" | "preserveCase">, smartCase: boolean): string {
  try {
    return replacementInContext(matchTextOf(hit), hit.text, replaceQueryOf(view, smartCase), view.replaceText, view.preserveCase);
  } catch {
    return view.replaceText;
  }
}

export function fileRequestsOf(hits: readonly SearchHit[], replacement: (hit: SearchHit) => string): ReplaceFileRequest[] {
  const byPath = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const list = byPath.get(hit.path);
    if (list) list.push(hit);
    else byPath.set(hit.path, [hit]);
  }
  return [...byPath].map(([path, fileHits]) => ({
    path,
    edits: fileHits.map((hit) => ({ range: { startLine: hit.line - 1, startCol: hit.start, endLine: hit.line - 1, endCol: hit.end }, expected: matchTextOf(hit), replacement: replacement(hit) })),
  }));
}

export function settleReplace(hits: readonly SearchHit[], results: readonly { path: string; status: string; applied: number }[]): { replaced: SearchHit[]; conflicts: string[]; failed: string[] } {
  const applied = new Set(results.filter((r) => r.status === "applied").map((r) => r.path));
  return {
    replaced: hits.filter((hit) => applied.has(hit.path)),
    conflicts: results.filter((r) => r.status === "conflict").map((r) => r.path),
    failed: results.filter((r) => r.status !== "applied" && r.status !== "conflict").map((r) => r.path),
  };
}

export function previewTextOf(text: string, hits: readonly SearchHit[], replacement: (hit: SearchHit) => string): string {
  const lines = text.split("\n");
  const byLine = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const list = byLine.get(hit.line);
    if (list) list.push(hit);
    else byLine.set(hit.line, [hit]);
  }
  for (const [number, lineHits] of byLine) {
    const raw = lines[number - 1];
    if (raw === undefined) continue;
    const cr = raw.endsWith("\r");
    const body = cr ? raw.slice(0, -1) : raw;
    let out = "";
    let at = 0;
    for (const hit of [...lineHits].sort((a, b) => a.start - b.start)) {
      if (hit.start < at) continue;
      out += body.slice(at, hit.start) + replacement(hit);
      at = hit.end;
    }
    lines[number - 1] = out + body.slice(at) + (cr ? "\r" : "");
  }
  return lines.join("\n");
}
