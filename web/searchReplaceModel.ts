import { replacementInContext, type ReplaceFileRequest, type ReplaceQuery } from "../shared/searchReplace";
import type { SearchSettings } from "../shared/searchSettings";
import { effectiveMatchCase, type SearchViewOptions } from "./searchViewModel";
import type { SearchHit } from "./searchTree";

// Search 뷰 바꾸기의 순수 규칙: 바꾸기가 켜졌는지, 일치 하나의 바뀔 글, 서버에 보낼 요청. 시험: test/searchtree.test.ts

// 바꾸기 줄이 펼쳐져 있으면 일치 행이 "원문 취소선 + 바뀔 글" 로 보이고 Replace 단추가 생긴다.
export const replaceShown = (view: Pick<SearchViewOptions, "showReplace">) => view.showReplace;

// 일치 행을 눌렀을 때 파일 대신 바꾸기 미리보기를 여는 조건(search.useReplacePreview, 바꿀 글이 비어 있지 않음)
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

// 일치들을 파일별 요청으로. 줄 번호와 열은 0 부터다(범위의 expected 는 검색 때 본 원문).
export function fileRequestsOf(hits: readonly SearchHit[], replacement: (hit: SearchHit) => string): ReplaceFileRequest[] {
  const byPath = new Map<string, SearchHit[]>();
  // 펼침으로 매번 새 배열을 만들면 한 파일에 일치가 수만 개일 때 제곱 시간이 걸려 화면이 멈춘다
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

// 바꾸기를 마친 뒤 결과 트리에서 뺄 일치와 충돌한 파일. 서버가 파일마다 알린 상태를 읽는다.
export function settleReplace(hits: readonly SearchHit[], results: readonly { path: string; status: string; applied: number }[]): { replaced: SearchHit[]; conflicts: string[]; failed: string[] } {
  const applied = new Set(results.filter((r) => r.status === "applied").map((r) => r.path));
  return {
    replaced: hits.filter((hit) => applied.has(hit.path)),
    conflicts: results.filter((r) => r.status === "conflict").map((r) => r.path),
    failed: results.filter((r) => r.status !== "applied" && r.status !== "conflict").map((r) => r.path),
  };
}

// 파일 글에서 일치들을 바꾼 글(바꾸기 미리보기의 오른쪽). 일치의 열은 줄 끝의 \r 을 뺀 줄 기준이다. 서로 겹치는 일치는 앞의 것만 쓴다.
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
