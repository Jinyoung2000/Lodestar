import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { hintDuration } from "./hintModel";

type Message = { pos: number; text: string };

const setMessage = StateEffect.define<Message | null>();

export const messageField = StateField.define<Message | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMessage)) return effect.value;
    // 다음 입력이나 커서 이동이면 닫는다
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
  provide: (field) => showTooltip.from(field, (message) => (message ? tooltipOf(message) : null)),
});

export function editorMessage(): Extension {
  return [
    messageField,
    // Esc 로 닫는다. 메시지가 없을 때는 다른 Esc 동작(제안 목록 닫기 등)에 넘긴다.
    Prec.highest(keymap.of([{ key: "Escape", run: (view) => (hasMessage(view) ? (closeEditorMessage(view), true) : false) }])),
    ViewPlugin.fromClass(MessageTimer),
  ];
}

// 이 에디터가 말풍선을 띄울 수 있는지(editorMessage 확장이 들어 있는지)
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

// 말풍선이 새로 뜨면 시간을 재고, 다 되면 닫는다.
class MessageTimer {
  private shown: Message | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate) {
    // 에디터 밖으로 포커스가 나가면 닫는다. 이 update 안에서는 dispatch 할 수 없어 다음 틱에 닫는다.
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
