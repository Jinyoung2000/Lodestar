import { highlightCode } from "@lezer/highlight";
import { syntaxHighlighters } from "./editorSyntax";
import { languageIdForFence } from "./languageId";
import { languageByName } from "./languages";

const DEFAULT_LANGUAGE = "typescript";

const highlighted = new WeakMap<object, Map<string, string>>();
const HIGHLIGHT_CACHE_MAX = 200;

const ELIDABLE_LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact", "json"]);
const ELLIPSIS_PLACEHOLDER = /(?<![\w$.])\.{3}(?![\w$.([{'"`])|…/g;
const blankOut = (match: string) => " ".repeat(match.length);

export function highlightCodeBlocks(html: string): string {
  if (!html.includes("<pre")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const code of doc.querySelectorAll("pre > code")) {
    const declared = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
    if (declared) code.parentElement!.dataset.lang = declared;
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
    pre.addEventListener("scroll", () => {
      button.style.transform = pre.scrollLeft ? `translateX(${pre.scrollLeft}px)` : "";
    }, { passive: true });
  }
}

const HEAT_LEVELS = 5;
const PERCENT_CELL = /^([-+]?\d[\d,]*(?:\.\d+)?)\s*%(?:\s*\([^()]*\))?$/;

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
