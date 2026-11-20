import { ATTACH_LIMIT, clip } from "../shared/notionContext";
import type { Note } from "../shared/notes";
import { rpc } from "./rpc";
import { draftText } from "./notesStore";
import { addAttachment, flash } from "./store";
import { S } from "./strings";

// 메모 하나를 입력창 칩으로 붙인다. 본문 전체가 프롬프트에 글로 들어간다(다른 세션 요약 칩과 같은 방식).
// 메모장에서 고치는 중인 글이 있으면 저장 전이어도 그 글을 붙인다. 없으면 데몬에서 읽는다.
export async function attachNote(paneId: string, note: Note) {
  try {
    const full = draftText(note.id) ?? (await rpc.call("notes.get", { id: note.id })).text;
    // 아주 긴 메모는 Notion 페이지 첨부와 같은 상한에서 자르고 얼마나 잘렸는지 적는다
    const clipped = clip(full, ATTACH_LIMIT);
    const text = clipped.truncated ? `${clipped.text}\n... ${S.attachNoteTruncated(clipped.total - clipped.text.length)}` : clipped.text;
    addAttachment(paneId, { workspaceId: null, path: note.id, startLine: null, endLine: null, text, note: { title: note.title || S.notesUntitled } });
  } catch {
    flash(S.attachNoteFailed);
  }
}
