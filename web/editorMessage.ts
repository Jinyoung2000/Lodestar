import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { hintDuration } from "./hintModel";

type Message = { pos: number; text: string };

const setMessage = StateEffect.define<Message | null>();

export const messageField = StateField.define<Message | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMessage)) return effect.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
  provide: (field) => showTooltip.from(field, (message) => (message ? tooltipOf(message) : null)),
});

export function editorMessage(): Extension {
  return [
    messageField,
    Prec.highest(keymap.of([{ key: "Escape", run: (view) => (hasMessage(view) ? (closeEditorMessage(view), true) : false) }])),
    ViewPlugin.fromClass(MessageTimer),
  ];
}

export function canShowEditorMessage(view: EditorView) {
  return view.state.field(messageField, false) !== undefined;
}

export function showEditorMessage(view: EditorView, text: string, pos = view.state.selection.main.head) {
  view.dispatch({ effects: setMessage.of({ pos, text }) });
}

export function closeEditorMessage(view: EditorView) {
  if (hasMessage(view)) view.dispatch({ effects: setMessage.of(null) });
}

function hasMessage(view: EditorView) {
  return !!view.state.field(messageField, false);
}

function tooltipOf(message: Message): Tooltip {
  return {
    pos: message.pos,
    above: true,
    strictSide: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "editor-message";
      dom.setAttribute("aria-hidden", "true");
      dom.setAttribute("data-testid", "editor-message");
      dom.textContent = message.text;
      return { dom };
    },
  };
}

class MessageTimer {
  private shown: Message | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (update.focusChanged && !update.view.hasFocus) queueMicrotask(() => closeEditorMessage(this.view));
    const message = update.state.field(messageField, false) ?? null;
    if (message === this.shown) return;
    this.shown = message;
    this.clear();
    if (message) this.timer = setTimeout(() => closeEditorMessage(this.view), hintDuration(message.text));
  }

  destroy() {
    this.clear();
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
