import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { dropCursor, EditorView, highlightSpecialChars, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { subscribeEditorFont } from "./editorFont";
import { currentEditorOptions, subscribeEditorOptions } from "./editorOptions";
import { bracketColorization, editorSyntax } from "./editorSyntax";
import { editorTheme } from "./Editor";
import { findWidget } from "./findWidget";
import { languageFor } from "./languages";
import { noteOptionExtensions, noteStyle } from "./noteStyle";
import { draftText, editNote, flushNote, loadNoteText, useNotes } from "./notesStore";
import { isChordPending } from "./shortcuts";
import { S } from "./strings";
import { Button } from "./ui/button";

export function NoteEditor({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const optionsRef = useRef(new Compartment());
  const appliedRemote = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const remote = useNotes((s) => s.remote);
  const focusNonce = useNotes((s) => s.focusNonce);
  const focusSeen = useRef(focusNonce);
  const pendingFocus = useRef(false);

  useEffect(() => {
    let disposed = false;
    let view: EditorView | null = null;
    setError(null);
    loadNoteText(id).then(
      (text) => {
        if (disposed || !hostRef.current) return;
        view = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              Prec.highest(
                keymap.of([
                  { key: "Mod-i", run: () => true },
                  { key: "Mod-f", run: () => isChordPending() },
                  { key: "Mod-ArrowLeft", run: () => isChordPending() },
                  { key: "Mod-ArrowRight", run: () => isChordPending() },
                  { key: "Mod-ArrowUp", run: () => isChordPending() },
                  { key: "Mod-ArrowDown", run: () => isChordPending() },
                ]),
              ),
              highlightSpecialChars(),
              history(),
              dropCursor(),
              EditorState.allowMultipleSelections.of(true),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              optionsRef.current.of(noteOptionExtensions(currentEditorOptions(), { path: null, languageId: "markdown", text })),
              findWidget(),
              languageFor("note.md"),
              editorTheme,
              editorSyntax(),
              bracketColorization.of(false),
              noteStyle,
              placeholder(S.notesPlaceholder),
              EditorView.contentAttributes.of({ "aria-label": S.notesEditorAria }),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) editNote(id, update.state.doc.toString());
              }),
            ],
          }),
        });
        viewRef.current = view;
        if (pendingFocus.current) {
          pendingFocus.current = false;
          view.focus();
        }
        view.dom.addEventListener("focusout", () => void flushNote(id));
      },
      (e: Error) => !disposed && setError(e.message),
    );
    return () => {
      disposed = true;
      viewRef.current = null;
      view?.destroy();
    };
  }, [id, retry]);

  useEffect(
    () =>
      subscribeEditorOptions((options) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: optionsRef.current.reconfigure(noteOptionExtensions(options, { path: null, languageId: "markdown", text: view.state.doc.toString() })) });
        view.requestMeasure();
      }),
    [],
  );
  useEffect(() => subscribeEditorFont(() => viewRef.current?.requestMeasure()), []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !remote || remote.id !== id || remote.nonce === appliedRemote.current) return;
    appliedRemote.current = remote.nonce;
    const apply = () => {
      if (draftText(id) === remote.text) replaceChanged(view, remote.text);
    };
    if (view.composing) view.contentDOM.addEventListener("compositionend", () => setTimeout(apply, 0), { once: true });
    else apply();
  }, [remote, id]);

  useEffect(() => {
    if (focusNonce === focusSeen.current) return;
    focusSeen.current = focusNonce;
    if (viewRef.current) viewRef.current.focus();
    else pendingFocus.current = true;
  }, [focusNonce]);

  if (error) {
    return (
      <div className="notes-editor-error" role="alert">
        <span>{S.notesLoadFailed(error)}</span>
        <Button size="sm" variant="secondary" onClick={() => setRetry((n) => n + 1)}>
          {S.notesRetry}
        </Button>
      </div>
    );
  }
  return <div ref={hostRef} className="notes-editor-host" />;
}

function replaceChanged(view: EditorView, next: string) {
  const prev = view.state.doc.toString();
  if (prev === next) return;
  let start = 0;
  const limit = Math.min(prev.length, next.length);
  while (start < limit && prev.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  if (start > 0 && isHighSurrogate(prev.charCodeAt(start - 1))) start -= 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev -= 1;
    endNext -= 1;
  }
  if (endPrev < prev.length && isLowSurrogate(prev.charCodeAt(endPrev))) {
    endPrev += 1;
    endNext += 1;
  }
  view.dispatch({ changes: { from: start, to: endPrev, insert: next.slice(start, endNext) }, annotations: Transaction.addToHistory.of(false) });
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
