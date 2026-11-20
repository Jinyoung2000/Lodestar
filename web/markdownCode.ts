import { highlightCode } from "@lezer/highlight";
import { syntaxHighlighters } from "./editorSyntax";
import { languageIdForFence } from "./languageId";
import { languageByName } from "./languages";

// 코드 펜스에 언어가 없으면 TypeScript 로 본다. 언어가 적혀 있는데 지원하지 않는 것(text 등)은 색 없이 둔다. 언어 이름은 파일 확장자와 같은 결정(web/languageId.ts)으로 읽고, 아직 안 읽은 언어는 읽기를 시작해 둔다(Markdown 컴포넌트가 useLanguagesVersion 으로 다시 그린다).
const DEFAULT_LANGUAGE = "typescript";

// 스트리밍 중에는 같은 응답이 프레임마다 다시 처리된다. 이미 끝난 코드 블록은 글이 같으니 색을 입힌 결과를 다시 쓴다(언어 파서별로 따로, 파서가 새로 읽히면 키가 달라진다).
const highlighted = new WeakMap<object, Map<string, string>>();
const HIGHLIGHT_CACHE_MAX = 200;

// 코드 일부를 줄였다는 뜻으로 쓰는 `...`, `…` 는 JS, TS, JSON 문법에서는 오류라 파서가 그 주변을 통째로 잘못 읽는다(`handler(values) { ... }` 의 handler 가 메서드로 안 읽히는 식). 스프레드(`...rest`, `...(`)가 아닌 것만 같은 길이의 공백으로 바꿔 파싱하고, 화면에는 원래 글을 그대로 보인다.
const ELIDABLE_LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact", "json"]);
const ELLIPSIS_PLACEHOLDER = /(?<![\w$.])\.{3}(?![\w$.([{'"`])|…/g;
const blankOut = (match: string) => " ".repeat(match.length);

// 응답 속 코드 블록(pre > code)에 에디터와 같은 구문 색 클래스(cm-syn-*)를 입힌다. 색은 styles.css 의 .markdown .cm-syn-* 가 준다.
export function highlightCodeBlocks(html: string): string {
  if (!html.includes("<pre")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const code of doc.querySelectorAll("pre > code")) {
    const declared = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
    const language = languageByName(declared ?? DEFAULT_LANGUAGE);
    if (!language) continue;
    const text = code.textContent ?? "";
    let cache = highlighted.get(language.parser);
    if (!cache) highlighted.set(language.parser, (cache = new Map()));
    const hit = cache.get(text);
    if (hit !== undefined) {
      code.innerHTML = hit;
      continue;
    }
    const fragment = doc.createDocumentFragment();
    const parseText = ELIDABLE_LANGUAGES.has(languageIdForFence(declared ?? DEFAULT_LANGUAGE) ?? "") ? text.replace(ELLIPSIS_PLACEHOLDER, blankOut) : text;
    highlightCode(
      text,
      language.parser.parse(parseText),
      syntaxHighlighters,
      (piece, cls) => {
        if (!cls) return void fragment.append(piece);
        const span = doc.createElement("span");
        span.className = cls;
        span.textContent = piece;
        fragment.append(span);
      },
      () => fragment.append("\n"),
    );
    code.replaceChildren(fragment);
    if (cache.size >= HIGHLIGHT_CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(text, code.innerHTML);
  }
  return doc.body.innerHTML;
}

// 코드 블록(pre) 오른쪽 위에 복사 버튼을 붙인다. 글자 없이 아이콘만 둬서 블록 글을 드래그해 복사할 때 섞이지 않는다. 같은 pre 에 두 번 붙이지 않는다.
export function addCodeCopyButtons(root: HTMLElement, label: string, copiedLabel: string) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.querySelector(":scope > .code-copy")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button code-copy";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    const show = (copied: boolean) => {
      icon.className = copied ? "codicon codicon-check" : "codicon codicon-copy";
      button.title = copied ? copiedLabel : label;
      button.setAttribute("aria-label", copied ? copiedLabel : label);
    };
    show(false);
    button.append(icon);
    let timer: number | undefined;
    button.addEventListener("click", () => {
      const text = (pre.querySelector("code") ?? pre).textContent ?? "";
      void navigator.clipboard.writeText(text).then(() => {
        show(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => show(false), 1500);
      });
    });
    pre.append(button);
    // pre 는 가로로 스크롤되는 상자라, 안의 absolute 버튼이 내용과 같이 밀려 중간에 보인다. 스크롤한 만큼 되돌려 오른쪽 위에 둔다.
    // pre 를 다른 상자로 감싸면 버튼은 고정되지만, 문단 다음 형제가 PRE 인지 보는 코드(web/fileRefMark.ts suggestedCodeFor)가 깨져서 감싸지 않는다.
    pre.addEventListener("scroll", () => {
      button.style.transform = pre.scrollLeft ? `translateX(${pre.scrollLeft}px)` : "";
    }, { passive: true });
  }
}

const HEAT_LEVELS = 5;
// 칸이 퍼센트 값 하나로 시작하면 그 값을 쓴다. 뒤에 괄호 설명이 붙은 "32.4% (대조군 대비 +62%)" 도 32.4 로 읽는다(사용자 10-27, A/B 열이 빠졌다).
const PERCENT_CELL = /^([-+]?\d[\d,]*(?:\.\d+)?)\s*%(?:\s*\([^()]*\))?$/;

// 응답 속 표에서 값이 전부 퍼센트인 열(머리 제외, 세 줄 이상)을 히트맵으로 칠한다. 열마다 가장 작은 값을 1, 가장 큰 값을 5단계로 나눠 셀에 data-heat 를 단다. 색은 styles.css 의 .markdown td[data-heat] 가 준다. 값이 모두 같거나 퍼센트가 아닌 칸이 섞인 열은 건드리지 않는다.
export function heatmapTables(html: string): string {
  if (!html.includes("<table")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;
  for (const table of doc.querySelectorAll("table")) {
    const rows = [...table.querySelectorAll("tr")].filter((row) => !row.closest("thead") && row.querySelector("td"));
    if (rows.length < 3) continue;
    const columns = Math.max(...rows.map((row) => row.cells.length));
    for (let col = 0; col < columns; col++) {
      const cells = rows.map((row) => row.cells[col]);
      const filled = cells.filter((cell): cell is HTMLTableCellElement => !!cell && !!cell.textContent?.trim());
      if (filled.length < 3 || !filled.every((cell) => PERCENT_CELL.test(cell.textContent!.trim()))) continue;
      const values = filled.map((cell) => parseFloat(PERCENT_CELL.exec(cell.textContent!.trim())![1]!.replace(/,/g, "")));
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max === min) continue;
      filled.forEach((cell, i) => {
        const level = Math.min(HEAT_LEVELS, 1 + Math.floor(((values[i]! - min) / (max - min)) * HEAT_LEVELS));
        cell.dataset.heat = String(level);
      });
      changed = true;
    }
  }
  return changed ? doc.body.innerHTML : html;
}
