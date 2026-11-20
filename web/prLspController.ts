import type { DiffRow } from "../shared/prDiff";
import { sameCodeLine } from "../shared/prLsp";
import { hint } from "./hint";
import { plainHoverBox } from "./hoverBox";
import { loadHoverData } from "./lspHoverData";
import { CODE_SELECTOR, codeCellOf, HoverTip, paintHighlight, rangeIn, textOffsetIn, wordAtOffset, wordAtPoint, type WordHit } from "./prLspDom";
import { docPosition, type PrDoc } from "./prLspDocs";
import { S } from "./strings";

// PR diff 의 새 쪽 코드 칸에 언어 기능을 얹는다. 화면은 patch 의 줄을 그린 DOM 이라서 CodeMirror 의 hover, 정의 링크, 키맵이 붙을 곳이 없다.
// 이 클래스가 마우스와 키 입력을 받아 칸 안 글자 위치를 문서 위치(PrDoc)로 옮기고, 서버 질문은 문서의 LSPPlugin 으로 보내며, 결과는 DOM 상자와 CSS Highlight 로 보인다.
//   hover: 단어 위에 0.3초 머물면 상자(진단, 타입, 문서)  ⌘ 를 누른 채 올리면 정의가 있는 단어에 밑줄  ⌘클릭 또는 F12: 정의로 이동  ⇧F12: 참조 목록
// 삭제 줄과 옛 쪽(LEFT)에는 아무것도 붙이지 않는다(diff 의 원본 쪽과 같은 원칙).

export type LspLocation = { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };

export type ControllerHooks = {
  rows: () => DiffRow[];
  doc: () => PrDoc | null;
  definition: (doc: PrDoc, pos: number) => Promise<LspLocation[]>;
  references: (doc: PrDoc, pos: number, word: string) => Promise<void>;
  navigate: (location: LspLocation, from: PrDoc) => void;
  // 문서의 줄 글이 patch 의 줄 글과 다르다(체크아웃한 폴더의 파일이 PR head 와 다르다). 그 줄에는 기능을 붙이지 않는다.
  mismatch: () => void;
  // 오른쪽 클릭: 화면 좌표. 메뉴는 호출한 쪽이 띄운다
  contextMenu: (x: number, y: number) => void;
};

type Caret = { code: HTMLElement; index: number; offset: number };

const HOVER_DELAY_MS = 300;
const HIDE_DELAY_MS = 200;

export class PrCodeLsp {
  private tip = new HoverTip();
  private caret: Caret | null = null;
  private pointer: { x: number; y: number } | null = null;
  private modifier = false;
  private current: { code: HTMLElement; index: number; word: WordHit } | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;
  private linkCache = new Map<string, boolean>();

  constructor(
    private root: HTMLElement,
    private hooks: ControllerHooks,
  ) {
    root.addEventListener("mousemove", this.onMove);
    root.addEventListener("mouseleave", this.onLeave);
    root.addEventListener("mousedown", this.onDown, true);
    root.addEventListener("mouseup", this.onUp);
    root.addEventListener("keydown", this.onKey);
    root.addEventListener("contextmenu", this.onContext);
    window.addEventListener("keydown", this.onModifier, true);
    window.addEventListener("keyup", this.onModifier, true);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("scroll", this.onScroll, true);
    root.tabIndex = -1;
  }

  destroy() {
    this.root.removeEventListener("mousemove", this.onMove);
    this.root.removeEventListener("mouseleave", this.onLeave);
    this.root.removeEventListener("mousedown", this.onDown, true);
    this.root.removeEventListener("mouseup", this.onUp);
    this.root.removeEventListener("keydown", this.onKey);
    this.root.removeEventListener("contextmenu", this.onContext);
    window.removeEventListener("keydown", this.onModifier, true);
    window.removeEventListener("keyup", this.onModifier, true);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("scroll", this.onScroll, true);
    this.reset();
    paintHighlight("pr-lsp-caret", []);
    this.caret = null;
  }

  // --- 위치 ---

  // 칸의 행 번호와 patch 줄. 새 쪽 줄이 아니면 null
  private lineOf(code: HTMLElement) {
    const index = Number(code.dataset.row);
    const row = this.hooks.rows()[index];
    return row?.kind === "line" && row.newLine !== null && row.type !== "del" ? { index, row, newLine: row.newLine } : null;
  }

  // 칸 안 offset 의 문서 위치. 문서의 그 줄이 patch 의 줄과 다르면 null(체크아웃한 파일이 PR head 와 어긋난 곳)
  private position(doc: PrDoc, code: HTMLElement, offset: number): number | null {
    const line = this.lineOf(code);
    if (!line || doc.evicted) return null;
    const lines = doc.view.state.doc;
    if (line.newLine > lines.lines) return null;
    if (!sameCodeLine(lines.line(line.newLine).text, line.row.text)) {
      this.hooks.mismatch();
      return null;
    }
    return docPosition(doc, line.newLine, offset);
  }

  private hit(event: MouseEvent) {
    const code = codeCellOf(event.target);
    if (!code || !this.lineOf(code)) return null;
    const word = wordAtPoint(code, code.textContent ?? "", event.clientX, event.clientY);
    return word ? { code, index: Number(code.dataset.row), word } : null;
  }

  // --- hover 와 ⌘ 링크 ---

  private onMove = (event: MouseEvent) => {
    this.pointer = { x: event.clientX, y: event.clientY };
    this.modifier = event.metaKey || event.ctrlKey;
    if (this.tip.contains(event.target)) {
      this.cancelHide();
      return;
    }
    this.evaluate(this.hit(event));
  };

  private onLeave = () => {
    this.pointer = null;
    this.scheduleHide();
    this.clearLink();
    this.stopHover();
  };

  private evaluate(hit: { code: HTMLElement; index: number; word: WordHit } | null) {
    const same = !!hit && !!this.current && hit.code === this.current.code && hit.word.from === this.current.word.from;
    this.current = hit;
    if (!hit) {
      this.stopHover();
      this.clearLink();
      this.scheduleHide();
      return;
    }
    if (same) return;
    this.stopHover();
    this.scheduleHide();
    if (this.modifier) {
      void this.showLink(hit);
      return;
    }
    this.clearLink();
    this.hoverTimer = setTimeout(() => void this.showHover(hit), HOVER_DELAY_MS);
  }

  private onModifier = (event: KeyboardEvent) => {
    const next = event.metaKey || event.ctrlKey;
    if (next === this.modifier) return;
    this.modifier = next;
    if (!this.pointer) return;
    const target = document.elementFromPoint(this.pointer.x, this.pointer.y);
    const code = codeCellOf(target);
    const word = code && this.lineOf(code) ? wordAtPoint(code, code.textContent ?? "", this.pointer.x, this.pointer.y) : null;
    this.current = null;
    this.evaluate(word && code ? { code, index: Number(code.dataset.row), word } : null);
  };

  private onBlur = () => {
    this.modifier = false;
    this.clearLink();
    this.tip.hide();
  };

  private onScroll = (event: Event) => {
    // hover 상자 안을 스크롤하는 건 닫을 이유가 아니다
    if (this.tip.contains(event.target)) return;
    this.stopHover();
    this.tip.hide();
    this.clearLink();
    this.current = null;
  };

  private stopHover() {
    this.token++;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
  }

  private scheduleHide() {
    if (!this.tip.element || this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.tip.hide();
    }, HIDE_DELAY_MS);
  }

  private cancelHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private async showHover(hit: { code: HTMLElement; index: number; word: WordHit }) {
    const doc = this.hooks.doc();
    if (!doc) return;
    const pos = this.position(doc, hit.code, hit.word.from);
    if (pos === null) return;
    const token = ++this.token;
    const data = await loadHoverData(doc.plugin, pos, doc.workspaceId).catch(() => null);
    if (token !== this.token || !data || (!data.html && !data.diagnostics.length)) return;
    this.cancelHide();
    this.tip.show(plainHoverBox(data), hit.word.rect, doc.view.dom.className);
  }

  private async showLink(hit: { code: HTMLElement; index: number; word: WordHit }) {
    const doc = this.hooks.doc();
    if (!doc) return;
    const key = `${doc.uri}\0${hit.index}:${hit.word.from}`;
    const token = ++this.token;
    let has = this.linkCache.get(key);
    if (has === undefined) {
      const pos = this.position(doc, hit.code, hit.word.from);
      has = pos !== null && (await this.hooks.definition(doc, pos).catch(() => [])).length > 0;
      this.linkCache.set(key, has);
    }
    if (token !== this.token || !this.modifier) return;
    if (has) {
      paintHighlight("pr-lsp-link", [rangeIn(hit.code, hit.word.from, hit.word.to)]);
      this.root.dataset.lspLink = "";
    } else this.clearLink();
  }

  private clearLink() {
    paintHighlight("pr-lsp-link", []);
    delete this.root.dataset.lspLink;
  }

  private reset() {
    this.stopHover();
    this.cancelHide();
    this.tip.hide();
    this.clearLink();
  }

  // --- 클릭, 캐럿, 키 ---

  // ⌘클릭은 선택을 시작하지 않고 정의로 간다. 캐럿은 클릭한 자리다.
  private onDown = (event: MouseEvent) => {
    this.tip.hide();
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    const hit = this.hit(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    this.setCaret(hit.code, hit.word.from);
    void this.goToDefinition();
  };

  // 클릭으로 만들어진 접힌 선택(캐럿)을 기억한다. 드래그로 글을 고르면 캐럿이 아니다.
  private onUp = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    const selection = window.getSelection();
    const code = selection?.anchorNode ? codeCellOf(selection.anchorNode) : null;
    if (!selection || !selection.isCollapsed || !code || !this.lineOf(code)) {
      if (!selection || selection.isCollapsed) this.clearCaret();
      return;
    }
    this.setCaret(code, textOffsetIn(code, selection.anchorNode!, selection.anchorOffset));
  };

  setCaret(code: HTMLElement, offset: number) {
    this.caret = { code, index: Number(code.dataset.row), offset };
    const word = wordAtOffset(code, code.textContent ?? "", offset);
    paintHighlight("pr-lsp-caret", word ? [rangeIn(code, word.from, word.to)] : []);
    this.root.focus({ preventScroll: true });
  }

  private clearCaret() {
    this.caret = null;
    paintHighlight("pr-lsp-caret", []);
  }

  private onContext = (event: MouseEvent) => {
    const hit = this.hit(event);
    if (!hit || !this.hooks.doc()) return;
    event.preventDefault();
    this.tip.hide();
    this.setCaret(hit.code, hit.word.from);
    this.hooks.contextMenu(event.clientX, event.clientY);
  };

  private onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.reset();
      return;
    }
    if (event.key !== "F12" || !this.caret) return;
    event.preventDefault();
    if (event.shiftKey) void this.findReferences();
    else void this.goToDefinition();
  };

  // 캐럿이 있는 자리의 문서 위치와 단어
  private caretTarget() {
    const doc = this.hooks.doc();
    const caret = this.caret;
    if (!doc || !caret || !caret.code.isConnected) return null;
    const text = caret.code.textContent ?? "";
    const word = wordAtOffset(caret.code, text, caret.offset);
    const pos = this.position(doc, caret.code, word?.from ?? caret.offset);
    return pos === null ? null : { doc, pos, word: word?.text ?? "", code: caret.code };
  }

  async goToDefinition() {
    const target = this.caretTarget();
    if (!target) return;
    const [first] = await this.hooks.definition(target.doc, target.pos).catch(() => []);
    if (!first) {
      hint(S.definitionNotFound, target.code);
      return;
    }
    this.hooks.navigate(first, target.doc);
  }

  async findReferences() {
    const target = this.caretTarget();
    if (!target) return;
    await this.hooks.references(target.doc, target.pos, target.word);
  }

  hasCaret() {
    return this.caret !== null;
  }

  // 정의 이동으로 이 화면의 줄에 도착했을 때 그 줄 글자 위치에 캐럿을 둔다
  caretAt(index: number, offset: number) {
    const code = this.root.querySelector<HTMLElement>(`${CODE_SELECTOR}[data-row="${index}"]`);
    if (code) this.setCaret(code, offset);
    return code;
  }
}

