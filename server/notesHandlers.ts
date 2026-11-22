import type { NoteStore } from "./notes";
import type { HandlersFor, MethodsIn } from "./rpcHandlers";

export type NotesHandlerDeps = { notes: NoteStore; publishNotes: () => void };

export function notesHandlers(deps: NotesHandlerDeps): HandlersFor<MethodsIn<"notes">> {
  const { notes, publishNotes } = deps;
  return {
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
