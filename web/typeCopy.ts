import { LSPPlugin } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import { loadTypeAt } from "./lspHoverData";
import { flash } from "./store";
import { S } from "./strings";
import { hint } from "./hint";

// Copy Type, Copy Signature: 붙여넣어 바로 쓸 수 있는 타입 식만 클립보드에 넣는다(web/typeParts.ts 가 tsserver 조각에서 만든다).

export type CopyKind = "type" | "signature";

// 커서 위치의 기호로 복사한다(명령 팔레트와 우클릭 메뉴).
export async function copyTypeAtCursor(view: EditorView, kind: CopyKind) {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const head = view.state.selection.main.head;
  const word = view.state.wordAt(head);
  const { type, signature } = await loadTypeAt(plugin, word ? word.from : head).catch(() => ({ type: null, signature: null }));
  copyResult(kind === "type" ? type : signature, kind);
}

// hover 상자의 단추: 이미 받아 둔 문자열을 복사한다.
export function copyResult(text: string | null, kind: CopyKind) {
  if (!text) {
    hint(kind === "type" ? S.noTypeHere : S.noSignatureHere);
    return;
  }
  void writeClipboard(text).then(
    // 복사한 글은 길 수 있어 문구에 싣지 않고, 누른 단추 자리에 체크 표시와 "Copied" 만 보인다
    () => hint(S.copied, undefined, { check: true }),
    () => flash(S.copyFailed, "error"),
  );
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 문서에 포커스가 없을 때 writeText 가 거절되면 선택 복사로 되돌아간다.
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
