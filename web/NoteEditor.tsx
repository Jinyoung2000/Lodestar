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

// 메모 하나의 편집기. 코드 에디터(web/Editor.tsx)와 같은 CodeMirror 바탕, 글꼴, 색, 마크다운 강조를 쓰되 파일 탭과는 이어지지 않는 작은 보기다.
// 글은 이 보기가 아니라 web/notesStore.ts 의 초안이 들고 있고, 보기는 바뀔 때마다 초안에 알린다(저장 시점은 저장소가 정한다).
// 메모마다 새로 만든다(key=id): 메모를 옮기면 이전 보기가 사라지고 새 보기가 초안이나 데몬의 글로 시작한다.
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
  // 포커스 요청이 보기가 만들어지기 전에 왔으면 만들어진 뒤에 준다
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
              // ⌘I 는 전역 빠른 질문이고, ⌘K 뒤의 ⌘화살표는 칸 이동 chord 의 두 번째 키다(Editor.tsx 와 같은 이유). chord 가 없을 때는 기본 편집 키 그대로다.
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

  // 에디터 동작 설정과 코드 글꼴이 바뀌면 코드 에디터처럼 따라간다.
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

  // 다른 창이 바꾼 글은 바뀐 부분만 갈아 끼워서 커서와 스크롤이 그대로 있게 한다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !remote || remote.id !== id || remote.nonce === appliedRemote.current) return;
    appliedRemote.current = remote.nonce;
    // 한글 같은 조합 입력 중에는 글을 갈아 끼우지 않고 조합이 끝난 뒤에 적용한다. 그 사이 이쪽에서 더 썼으면(초안이 바뀌었으면) 이쪽 글이 이긴다.
    const apply = () => {
      if (draftText(id) === remote.text) replaceChanged(view, remote.text);
    };
    if (view.composing) view.contentDOM.addEventListener("compositionend", () => setTimeout(apply, 0), { once: true });
    else apply();
  }, [remote, id]);

  // 새 메모를 만들었거나 빈 메모가 이미 열려 있을 때 포커스를 준다.
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

// 앞뒤로 같은 글을 빼고 가운데만 바꾼다. 서로게이트 쌍(이모지)의 한가운데를 자르지 않도록 경계를 한 칸 넓힌다.
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
