import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { loadTypeAt } from "./lspHoverData";
import { flash } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

export type CopyKind = "type" | "signature";

export async function copyTypeAtCursor(view: EditorView, kind: CopyKind) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const head = view.state.selection.main.head;
  const word = view.state.wordAt(head);
  const { type, signature } = await loadTypeAt(plugin, word ? word.from : head).catch(() => ({ type: null, signature: null }));
  copyResult(kind === "type" ? type : signature, kind);
}

export function copyResult(text: string | null, kind: CopyKind) {
  if (!text) {
    hint(kind === "type" ? S.noTypeHere : S.noSignatureHere);
    return;
  }
  void writeClipboard(text).then(
    () => hint(S.copied, undefined, { check: true }),
    () => flash(S.copyFailed, "error"),
  );
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("copy failed");
  }
}
