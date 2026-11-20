import { LSPPlugin } from "@codemirror/lsp-client";
import { Prec, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorOptions } from "../shared/editorOptions";
import { indentColumns, lightbulbInfo, placeLightbulb, shouldRequestLightbulb, type LightbulbPlacement } from "./codeActionModel";
import { registerEditorCommands } from "./editorCommands";
import { commandKeyLabel } from "./shortcutList";
import { autoFixAtCursor, diagnosticsOver, openQuickFix, requestCodeActions, showCodeActionMenu, usable, type CodeAction } from "./quickFix";
import { subscribeDiagnostics } from "./diagnosticsStore";
import "./editorLightbulb.css";


const AUTO_DELAY_MS = 250;

registerEditorCommands([{ id: "autoFix", title: "Auto Fix...", run: (view) => (void autoFixAtCursor(view), true) }]);

// doc 은 제안을 요청한 때의 문서다. 제안의 편집 위치가 이 문서 기준이다.
type Bulb = { actions: CodeAction[]; placement: LightbulbPlacement; icon: "light-bulb" | "lightbulb-autofix"; title: string; cursorLine: number; doc: Text };

const setBulb = StateEffect.define<Bulb | null>();

const bulbField = StateField.define<Bulb | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBulb)) return effect.value;
    // 줄이 지워져 전구 자리가 문서 밖이면 바로 숨긴다(번들 onDidChangeModelContent)
    if (value && tr.docChanged && value.placement.kind !== "none" && value.placement.line > tr.state.doc.lines) return null;
    return value;
  },
});

export function lightbulbExtension(options: Pick<EditorOptions, "lightbulb">, context?: { languageId: string | null }): Extension {
  if (options.lightbulb === "off") return [];
  const mode = options.lightbulb;
  return [bulbField, glyphGutter(context?.languageId != null), ViewPlugin.fromClass(class LightbulbController {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private token = { cancelled: false };
    private dom: HTMLElement | null = null;
    private off: () => void;

    constructor(private view: EditorView) {
      this.off = subscribeDiagnostics(() => this.schedule());
      this.schedule();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.schedule();
      if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setBulb)))) this.layout();
    }

    destroy() {
      this.off();
      if (this.timer) clearTimeout(this.timer);
      this.token.cancelled = true;
      this.dom?.remove();
    }

    private schedule() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.run(), AUTO_DELAY_MS);
    }

    private async run() {
      this.timer = null;
      this.token.cancelled = true;
      const token = (this.token = { cancelled: false });
      const view = this.view;
      const plugin = LSPPlugin.get(view);
      const selection = view.state.selection.main;
      const line = view.state.doc.lineAt(selection.from);
      if (!plugin || !view.hasFocus || !shouldRequestLightbulb(mode, selection.empty, line.text, selection.from - line.from + 1)) {
        this.hide();
        return;
      }
      const diagnostics = diagnosticsOver(plugin, selection.from, selection.to);
      const range = { start: plugin.toPosition(selection.from), end: plugin.toPosition(selection.to) };
      const doc = view.state.doc;
      let actions: CodeAction[];
      try {
        actions = usable(plugin, await requestCodeActions(plugin, range, diagnostics, 2, undefined, token));
      } catch {
        actions = [];
      }
      // 기다리는 동안 글이 바뀌었으면 이미 다음 요청이 예약되어 있다(update 의 docChanged). 낡은 제안으로 전구를 띄우지 않는다.
      if (token.cancelled || !view.dom.isConnected || view.state.doc !== doc) return;
      const current = view.state.selection.main;
      if (!view.hasFocus || view.state.doc.lineAt(current.from).number !== line.number || !actions.length) {
        this.hide();
        return;
      }
      const info = lightbulbInfo(actions, { autoFix: commandKeyLabel("editor:autoFix") ?? "", quickFix: commandKeyLabel("quickFix") ?? "" });
      const placement = placeLightbulb({
        line: line.number,
        column: selection.from - line.from + 1,
        lineCount: view.state.doc.lines,
        lineText: (n) => view.state.doc.line(Math.min(Math.max(n, 1), view.state.doc.lines)).text,
        indentWidth: indentColumns(line.text, view.state.tabSize),
        spaceWidth: view.defaultCharacterWidth,
        hidden: (n) => isFolded(view, n),
      });
      view.dispatch({ effects: setBulb.of(placement.kind === "none" ? null : { actions, placement, icon: info.icon, title: info.title, cursorLine: line.number, doc }) });
    }

    private hide() {
      if (this.view.state.field(bulbField)) this.view.dispatch({ effects: setBulb.of(null) });
    }

    // 들여쓰기 자리 전구는 스크롤 영역 안에 놓아 글자와 함께 움직인다. 위치는 줄 블록 위와 글자 시작 x 로 잰다.
    private layout() {
      const view = this.view;
      const bulb = view.state.field(bulbField);
      if (!bulb || bulb.placement.kind !== "widget") {
        this.dom?.remove();
        this.dom = null;
        return;
      }
      const placement = bulb.placement;
      view.requestMeasure({
        key: this,
        read: () => {
          const line = view.state.doc.line(Math.min(placement.line, view.state.doc.lines));
          const pos = Math.min(line.from + placement.column - 1, line.to);
          const coords = view.coordsAtPos(pos);
          if (!coords || !view.viewport || line.from < view.viewport.from || line.from > view.viewport.to) return null;
          const scroll = view.scrollDOM.getBoundingClientRect();
          return { left: coords.left - scroll.left + view.scrollDOM.scrollLeft, top: view.documentTop + view.lineBlockAt(line.from).top - scroll.top + view.scrollDOM.scrollTop };
        },
        write: (position) => {
          if (!position) {
            this.dom?.remove();
            this.dom = null;
            return;
          }
          const el = this.dom ?? this.create();
          el.className = `cm-lightbulb codicon codicon-${bulb.icon}`;
          el.title = bulb.title;
          el.style.left = `${position.left}px`;
          el.style.top = `${position.top}px`;
          if (!el.isConnected) view.scrollDOM.append(el);
        },
      });
    }

    private create() {
      const el = document.createElement("div");
      el.setAttribute("role", "button");
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const bulb = this.view.state.field(bulbField);
        if (bulb) openFromBulb(this.view, bulb, el.getBoundingClientRect(), event.clientX);
      });
      this.dom = el;
      return el;
    }
  })];
}

function isFolded(view: EditorView, lineNumber: number) {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return true;
  const line = view.state.doc.line(lineNumber);
  return view.lineBlockAt(line.from).from !== line.from;
}

// 번들 클릭 처리: 기준점은 마우스 x, 전구 아래 줄 높이의 3분의 1. 전구가 커서 줄보다 위에 있으면 한 줄 더 내려 커서 줄 아래에 둔다.
function openFromBulb(view: EditorView, bulb: Bulb, rect: DOMRect, x: number) {
  // 전구를 띄운 뒤 글이 바뀌었으면(다시 요청하기 전 250ms 사이) 그 제안의 위치는 낡았다. ⌘. 처럼 지금 글로 다시 받아 띄운다.
  if (bulb.doc !== view.state.doc) {
    void openQuickFix(view);
    return;
  }
  const lineHeight = view.defaultLineHeight;
  const above = bulb.placement.kind !== "none" && bulb.placement.line < bulb.cursorLine;
  const bottom = rect.bottom + Math.floor(lineHeight / 3) + (above ? lineHeight : 0);
  showCodeActionMenu(view, bulb.actions, { x, top: rect.top, bottom });
}

class GlyphMarker extends GutterMarker {
  constructor(private bulb: Bulb) {
    super();
  }
  eq(other: GlyphMarker) {
    return other.bulb.icon === this.bulb.icon && other.bulb.title === this.bulb.title;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-lightbulb-glyph codicon codicon-${this.bulb.icon}`;
    el.title = this.bulb.title;
    return el;
  }
}

function glyphGutter(reserve: boolean): Extension {
  if (!reserve) return [];
  // 줄 번호와 접기 거터보다 앞(왼쪽)에 놓이도록 우선순위를 높인다
  return Prec.high(gutter({
    class: "cm-glyph-margin",
    lineMarker(view, line) {
      const bulb = view.state.field(bulbField);
      if (!bulb || bulb.placement.kind !== "gutter") return null;
      return view.state.doc.lineAt(line.from).number === bulb.placement.line ? new GlyphMarker(bulb) : null;
    },
    lineMarkerChange: (update) => update.state.field(bulbField) !== update.startState.field(bulbField),
    domEventHandlers: {
      mousedown(view, line, event) {
        const bulb = view.state.field(bulbField);
        if (!bulb || bulb.placement.kind !== "gutter" || view.state.doc.lineAt(line.from).number !== bulb.placement.line) return false;
        event.preventDefault();
        const cell = (event.target as HTMLElement).closest(".cm-gutterElement") ?? (event.target as HTMLElement);
        const icon = cell.querySelector(".cm-lightbulb-glyph") ?? cell;
        openFromBulb(view, bulb, icon.getBoundingClientRect(), (event as MouseEvent).clientX);
        return true;
      },
    },
  }));
}
