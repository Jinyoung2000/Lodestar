import type { NoteStore } from "./notes";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type NotesHandlerDeps = { notes: NoteStore; publishNotes: () => void };

export function notesHandlers(deps: NotesHandlerDeps): HandlersFor<MethodsIn<"notes">> {
  const { notes, publishNotes } = deps;
  return {
    // NOTES: 메모장. 바뀐 뒤에는 전체 목록을 모든 창에 알린다(본문은 싣지 않는다).
    "notes.list": ({ query }) => notes.list(typeof query === "string" ? query : ""),
    "notes.get": ({ id }) => notes.get(id),
    "notes.create": ({ text }) => {
      const note = notes.create(text);
      publishNotes();
      return note;
    },
    "notes.save": ({ id, text }) => {
      const before = notes.get(id).rev;
      const note = notes.save(id, text);
      if (note.rev !== before) publishNotes();
      return note;
    },
    "notes.delete": ({ id }) => {
      notes.delete(id);
      publishNotes();
      return null;
    },
  };
}
