import { LSPPlugin } from "@codemirror/lsp-client";
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { announce } from "./announce";
import type { LspRange } from "./diagnosticsStore";
import { hint } from "./hint";
import { previewWorkspaceEdit } from "./refactorPreview";
import { applyWorkspaceEdit } from "./quickFix";
import { countEdits, type WorkspaceEdit } from "./renameModel";
import { flash } from "./store";
import { S } from "./strings";
import { wordRangeAt } from "./wordHighlightModel";
import "./renameSymbol.css";


export const RENAME_TEXT = {
  cannotRename: "You cannot rename this element.",
  label: (accept: string, preview: string) => `${accept} to Rename, ${preview} to Preview`,
  inputAria: "Rename input. Type new name and press Enter to commit.",
  renaming: (from: string, to: string) => `Renaming '${from}' to '${to}'`,
  summary: (edits: number, files: number) => (edits === 0 ? "Made no edits" : files === 1 ? `Made ${edits} text edits in one file` : `Made ${edits} text edits in ${files} files`),
};

const ACCEPT_KEY = "Enter";
const PREVIEW_KEY = "⇧Enter";

type RenameBox = { from: number; text: string; selection: { start: number; end: number }; below: boolean };

const setRename = StateEffect.define<RenameBox | null>();

const renameField = StateField.define<RenameBox | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setRename)) return effect.value;
    return tr.docChanged ? null : value;
  },
  provide: (field) => showTooltip.from(field, (box) => (box ? boxTooltip(box) : null)),
});

// 이름 상자 상태. editorBase.ts 의 editorOptionExtensions 가 넣는다(F2 키는 web/intellisenseKeys.ts).
export const renameExtension = renameField;

export function renameSymbolAtCursor(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  const provider = plugin?.client.serverCapabilities?.renameProvider;
  if (!plugin || !provider) return false;
  if (view.state.field(renameField, false)) return true;
  void openRenameBox(view, plugin, typeof provider === "object" && !!provider.prepareProvider);
  return true;
}

async function openRenameBox(view: EditorView, plugin: LSPPlugin, prepare: boolean) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const word = wordRangeAt(line.text, head - line.from);
  let target = word ? { from: line.from + word.from, to: line.from + word.to } : null;
  let placeholder: string | null = null;
  if (prepare) {
    try {
      plugin.client.sync();
      const result = await plugin.client.request<object, PrepareResult | null>("textDocument/prepareRename", { textDocument: { uri: plugin.uri }, position: plugin.toPosition(head) });
      if (!result) {
        hint(RENAME_TEXT.cannotRename, view);
        return;
      }
      if ("range" in result) {
        target = { from: plugin.fromPosition(result.range.start), to: plugin.fromPosition(result.range.end) };
        placeholder = "placeholder" in result ? (result.placeholder ?? null) : null;
      }
    } catch (error) {
      hint(String((error as Error)?.message || RENAME_TEXT.cannotRename), view);
      return;
    }
  }
  if (!target || target.from === target.to) {
    hint(RENAME_TEXT.cannotRename, view);
    return;
  }
  const text = placeholder ?? view.state.sliceDoc(target.from, target.to);
  // 선택이 낱말 안에 있으면 그 부분만 고른다(번들 _getSelection). 아니면 이름 전체.
  const selection = view.state.selection.main;
  const inside = !selection.empty && view.state.doc.lineAt(selection.from).number === view.state.doc.lineAt(selection.to).number && selection.from >= target.from && selection.to <= target.to;
  view.dispatch({
    effects: [
      EditorView.scrollIntoView(target.from, { y: "nearest" }),
      setRename.of({ from: target.from, text, selection: inside ? { start: selection.from - target.from, end: selection.to - target.from } : { start: 0, end: text.length }, below: roomBelow(view, target.from) }),
    ],
  });
}

type PrepareResult = { range: LspRange; placeholder?: string } | { defaultBehavior: boolean };

function roomBelow(view: EditorView, pos: number) {
  const box = view.coordsAtPos(pos);
  if (!box) return true;
  const candidateHeight = view.defaultLineHeight + 4;
  return window.innerHeight - box.top > candidateHeight * 6;
}

function boxTooltip(box: RenameBox): Tooltip {
  return {
    pos: box.from,
    above: !box.below,
    arrow: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-rename";
      dom.dataset.preview = "";
      const field = document.createElement("div");
      field.className = "cm-rename-field";
      const input = document.createElement("input");
      input.className = "cm-rename-input";
      input.type = "text";
      input.value = box.text;
      input.size = Math.max(Math.round(box.text.length * 1.1), 20);
      input.spellcheck = false;
      input.autocomplete = "off";
      input.setAttribute("aria-label", RENAME_TEXT.inputAria);
      field.append(input);
      const label = document.createElement("div");
      label.className = "cm-rename-label";
      label.textContent = RENAME_TEXT.label(ACCEPT_KEY, PREVIEW_KEY);
      dom.append(field, label);
      // 상자 안쪽을 눌러도 입력칸 포커스가 빠지지 않게 한다
      dom.addEventListener("mousedown", (event) => {
        if (event.target !== input) event.preventDefault();
      });
      let done = false;
      const finish = (action: "accept" | "preview" | "cancel") => {
        if (done) return;
        done = true;
        view.dispatch({ effects: setRename.of(null) });
        view.focus();
        const name = input.value;
        if (action === "cancel" || name === box.text || name.trim().length === 0) return;
        void rename(view, box, name, action === "preview");
      };
      input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          finish(event.shiftKey ? "preview" : "accept");
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish("cancel");
        }
      });
      // 에디터 밖을 눌러 포커스가 나가면 취소한다. 이미 닫힌 뒤(done)의 blur 는 무시한다.
      input.addEventListener("blur", () => {
        if (!done) finish("cancel");
      });
      return {
        dom,
        mount() {
          input.focus();
          input.setSelectionRange(box.selection.start, box.selection.end);
        },
      };
    },
  };
}

async function rename(view: EditorView, box: RenameBox, newName: string, preview: boolean) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  try {
    view.dispatch({ selection: { anchor: view.state.selection.main.head } });
    plugin.client.sync();
    let edit = await plugin.client.request<object, WorkspaceEdit | null>("textDocument/rename", { newName, position: plugin.toPosition(box.from), textDocument: { uri: plugin.uri } });
    if (!edit || countEdits(edit).edits === 0) {
      hint(S.renameNothing, view);
      return;
    }
    if (preview) {
      const chosen = await previewWorkspaceEdit(view, plugin, edit, RENAME_TEXT.renaming(box.text, newName));
      view.focus();
      if (!chosen) return;
      edit = chosen;
    }
    await applyWorkspaceEdit(view, plugin, edit);
    const { edits, files } = countEdits(edit);
    announce(S.renamed(box.text, newName, RENAME_TEXT.summary(edits, files)));
  } catch (error) {
    flash(S.renameFailed((error as Error).message), "error");
  }
}
