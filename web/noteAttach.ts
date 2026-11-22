import { ATTACH_LIMIT, clip } from "../shared/notionContext";
import type { Note } from "../shared/notes";
import { rpc } from "./rpc";
import { draftText } from "./notesStore";
import { addAttachment, flash } from "./store";
import { S } from "./strings";

export async function attachNote(paneId: string, note: Note) {
  try {
    const full = draftText(note.id) ?? (await rpc.call("notes.get", { id: note.id })).text;
    const clipped = clip(full, ATTACH_LIMIT);
    const text = clipped.truncated ? `${clipped.text}\n... ${S.attachNoteTruncated(clipped.total - clipped.text.length)}` : clipped.text;
    addAttachment(paneId, { workspaceId: null, path: note.id, startLine: null, endLine: null, text, note: { title: note.title || S.notesUntitled } });
  } catch {
    flash(S.attachNoteFailed);
  }
}
