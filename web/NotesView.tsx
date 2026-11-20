import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { Note } from "../shared/notes";
import { shortTime } from "./Inbox";
import { Plus, Search, Trash } from "./icons";
import { NoteEditor } from "./NoteEditor";
import { createNote, deleteNote, flushNote, openNote, saveListScroll, savedListScroll, setQuery, useNotes, visibleNotes, type NoteSave } from "./notesStore";
import { S } from "./strings";
import { Button } from "./ui/button";

// 가운데 영역에 세션 격자 대신 보이는 메모장. 왼쪽에 메모 목록(첫 줄이 제목, 최근 수정 순)과 검색, 오른쪽에 열린 메모의 편집기가 있다.
// 글은 입력이 멈추면 저장되고, 메모를 옮기거나 이 화면을 떠나면 바로 저장된다(web/notesStore.ts). 열었던 메모와 목록 스크롤은 다시 들어올 때 돌아온다.
export function NotesView() {
  const notes = useNotes((s) => s.notes);
  const loadError = useNotes((s) => s.loadError);

  if (loadError) {
    return (
      <section className="notes-view" aria-label={S.notes}>
        <NotesHeader />
        <div className="empty-hint">{loadError}</div>
      </section>
    );
  }
  if (notes === null) {
    return (
      <section className="notes-view" aria-label={S.notes}>
        <NotesHeader />
      </section>
    );
  }
  if (notes.length === 0) {
    return (
      <section className="notes-view" aria-label={S.notes}>
        <NotesHeader />
        <div className="empty-hint">
          <div className="notes-empty">
            <span className="notes-empty-title">{S.notesEmpty}</span>
            <span>{S.notesEmptyBody}</span>
            <Button variant="primary" size="default" onClick={() => void createNote()}>
              <Plus size={14} /> {S.notesNew}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="split-view notes-split">
      <NotesList />
      <NotesEditorPane />
    </div>
  );
}

// 목록 칸과 빈 화면이 같이 쓰는 머리줄: 제목과 새 메모 단추
function NotesHeader() {
  return (
    <div className="pane-header">
      <span className="agent-title">{S.notes}</span>
      <span className="spacer" />
      <Button size="icon" aria-label={S.notesNew} title={S.notesNew} onClick={() => void createNote()}>
        <Plus size={14} />
      </Button>
    </div>
  );
}

function NotesList() {
  const list = useNotes(visibleNotes) ?? [];
  const query = useNotes((s) => s.query);
  const openId = useNotes((s) => s.openId);
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const firstPaint = useRef(true);

  // 처음 그릴 때는 저장해 둔 스크롤로 돌아가고, 그 뒤 열린 메모가 바뀌면(새 메모 등) 그 줄이 보이게만 한다.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (firstPaint.current) {
      firstPaint.current = false;
      el.scrollTop = savedListScroll();
      return;
    }
    el.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(openId ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  // 목록에서 ↑ ↓ 를 누르면 다음 메모를 열고 그 줄에 포커스를 둔다(Slack 화면과 같다).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!(event.target as HTMLElement).classList.contains("notes-row")) return;
    event.preventDefault();
    const index = list.findIndex((n) => n.id === (event.target as HTMLElement).dataset.noteId);
    const next = list[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    focusAfter.current = next.id;
    void openNote(next.id);
  };
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(id)}"]`)?.focus();
  }, [openId]);

  // 스크롤 위치는 프레임에 한 번만 저장한다
  const scrollFrame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => saveListScroll(listRef.current?.scrollTop ?? 0));
  };

  return (
    <section className="notes-list-pane" aria-label={S.notesAria}>
      <NotesHeader />
      <label className="notes-search">
        <Search size={14} />
        <input
          className="input"
          aria-label={S.notesSearch}
          placeholder={S.notesSearchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query && !e.nativeEvent.isComposing) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
      </label>
      <div className="notes-list" role="list" aria-label={S.notesAria} ref={listRef} onKeyDown={onKeyDown} onScroll={onScroll}>
        {list.length === 0 && <div className="empty-hint">{S.notesNoMatch}</div>}
        {list.map((note) => (
          <NoteRow key={note.id} note={note} selected={note.id === openId} />
        ))}
      </div>
    </section>
  );
}

function NoteRow({ note, selected }: { note: Note; selected: boolean }) {
  return (
    <div role="listitem" className="notes-item">
      <button type="button" className="notes-row" aria-current={selected || undefined} data-note-id={note.id} data-selected={selected || undefined} onClick={() => void openNote(note.id)}>
        <span className="notes-row-head">
          <span className="notes-row-title" data-empty={!note.title || undefined}>
            {note.title || S.notesUntitled}
          </span>
          <span className="faint xs" title={new Date(note.updatedAt).toLocaleString()}>
            {shortTime(note.updatedAt)}
          </span>
        </span>
        <span className="notes-row-line">{note.preview || S.notesNoText}</span>
      </button>
    </div>
  );
}

function NotesEditorPane() {
  const openId = useNotes((s) => s.openId);
  const title = useNotes((s) => s.notes?.find((n) => n.id === s.openId)?.title ?? "");
  const save = useNotes((s) => s.save);

  if (!openId) {
    return (
      <section className="notes-editor" aria-label={S.notesEditorAria}>
        <div className="pane-header" />
        <div className="empty-hint">{S.notesPickOne}</div>
      </section>
    );
  }
  return (
    <section className="notes-editor" aria-label={S.notesEditorAria}>
      <div className="pane-header">
        <span className="agent-title" data-empty={!title || undefined}>
          {title || S.notesUntitled}
        </span>
        <span className="spacer" />
        <span className="notes-status xs" role="status" data-state={save}>
          {SAVE_LABEL[save]}
        </span>
        <Button size="icon" aria-label={S.notesDelete} title={S.notesDelete} onClick={() => void deleteNote(openId)}>
          <Trash size={14} />
        </Button>
      </div>
      <div className="notes-editor-body">
        <NoteEditor key={openId} id={openId} />
      </div>
      {save === "error" && (
        <div className="notes-save-error" role="alert">
          <span>{S.notesSaveFailed}</span>
          <Button size="sm" variant="secondary" onClick={() => void flushNote(openId)}>
            {S.notesRetry}
          </Button>
        </div>
      )}
    </section>
  );
}

const SAVE_LABEL: Record<NoteSave, string> = { saved: S.notesSaved, saving: S.notesSaving, pending: S.notesUnsaved, error: S.notesNotSaved };
