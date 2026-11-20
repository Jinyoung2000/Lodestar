import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Note } from "../shared/notes";
import type { Agent } from "../shared/protocol";
import { attachFile, attachSession } from "./attachments";
import { rankFiles } from "./fileSearch";
import { CommentDiscussion, Codicon, DiffMultiple, Files, ImageFile, NoteIcon } from "./icons";
import { isNotionUrl, notionPageKey } from "../shared/notionLink";
import { attachNote } from "./noteAttach";
import { attachNotionPage } from "./notionAttach";
import { useNotes } from "./notesStore";
import { notionPins, useNotion } from "./notionStore";
import { N } from "./notionStrings";
import { IN_ELECTRON } from "./shortcuts";
import { FileTypeIcon } from "./FileTypeIcon";
import { Popup } from "./Popup";
import { ensureFiles, useStore, type Tab } from "./store";
import { S } from "./strings";

type View = "root" | "files" | "changes" | "sessions" | "notion" | "notes";

// 첨부 선택창(B3-10): `+` 또는 ⌘/. 맨 위에서 Sessions..., Changes, Files, Note... 를 고르고, 글자를 입력하면 바로 파일을 찾는다.
// Issue 와 Pull Request 항목은 만들지 않는다(명세 기본안).
export function AttachMenu({ paneId, workspaceId, agent, anchor, onClose, onPickImage }: { paneId: string; workspaceId: string | null; agent: Agent | null; anchor: HTMLElement | null; onClose: () => void; onPickImage: () => void }) {
  const [pickedView, setView] = useState<View>("root");
  // 폴더가 없는 세션(퀵 챗)에는 변경과 파일이 없어 다른 세션 요약, Notion 페이지, 메모만 붙일 수 있다.
  const view: View = pickedView;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const files = useStore((s) => (workspaceId ? s.files[workspaceId] : undefined));
  const changes = useStore((s) => (agent ? s.gitChanges[agent.id]?.files : undefined));
  const agents = useStore((s) => s.agents);
  const tabs = useStore((s) => s.tabs);
  const pins = useNotion((s) => s.pins);
  const notes = useNotes((s) => s.notes);

  useEffect(() => {
    if (workspaceId) void ensureFiles(workspaceId);
  }, [workspaceId]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const changed = (changes ?? []).map((f) => ({ path: f.path, label: f.path.slice(f.path.lastIndexOf("/") + 1), detail: f.rel, rel: f.rel }));
    const changedMatches = q ? rankFiles(changed.map((c) => c.rel), q).map((rel) => changed.find((c) => c.rel === rel)!) : changed;
    if (view === "root" && !q) {
      const notion: Row[] = IN_ELECTRON ? [{ key: "notion", kind: "category", title: N.attachRow, icon: <Codicon name="file" />, go: "notion" }] : [];
      const note: Row = { key: "notes", kind: "category", title: S.attachNotes, icon: <NoteIcon />, go: "notes" };
      if (!workspaceId) return [{ key: "sessions", kind: "category", title: S.attachSessions, icon: <CommentDiscussion />, go: "sessions" }, ...notion, note];
      return [
        { key: "sessions", kind: "category", title: S.attachSessions, icon: <CommentDiscussion />, go: "sessions" },
        { key: "changes", kind: "category", title: S.attachChanges, icon: <DiffMultiple />, go: "changes" },
        { key: "files", kind: "category", title: S.attachFiles, icon: <Files />, go: "files" },
        { key: "image", kind: "image", title: S.attachImage, icon: <ImageFile /> },
        ...notion,
        note,
      ];
    }
    if (view === "notion") return notionRows(tabs, q);
    if (view === "notes") return noteRows(notes ?? [], q);
    const changeRows: Row[] = changedMatches.map((c) => ({ key: `c:${c.path}`, kind: "file", title: c.label, detail: c.detail, name: c.label, choose: { workspaceId: workspaceId!, path: c.path } }));
    const fileRows = (): Row[] => rankFiles(files ?? [], q, 50).map((path) => ({ key: `f:${path}`, kind: "file", title: path.slice(path.lastIndexOf("/") + 1), detail: path.slice(0, path.lastIndexOf("/") + 1), name: path, choose: { workspaceId: workspaceId!, path } }));
    if (view === "changes") return changeRows;
    if (view === "sessions") {
      const others = agents.filter((a) => a.id !== agent?.id && !a.feedbackId && (!q || a.title.toLowerCase().includes(q.toLowerCase())));
      return others.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map((a) => ({ key: `s:${a.id}`, kind: "session", title: a.title, session: a }));
    }
    if (view === "files") return fileRows();
    const changedPaths = new Set(changeRows.map((r) => (r.kind === "file" ? r.detail : "")));
    return [...changeRows, ...fileRows().filter((r) => r.kind === "file" && !changedPaths.has(r.name))].slice(0, 50);
  }, [view, query, files, changes, agents, tabs, pins, notes, agent?.id, workspaceId]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "category") {
      setView(row.go);
      setQuery("");
      setIndex(0);
      return;
    }
    onClose();
    if (row.kind === "image") {
      onPickImage();
      return;
    }
    if (row.kind === "file") attachFile(paneId, row.choose.workspaceId, row.choose.path);
    else if (row.kind === "note") void attachNote(paneId, row.note);
    else if (row.kind === "notion") void attachNotionPage({ url: row.url, title: row.title, tabKey: row.tabKey, paneId });
    else void attachSession(paneId, workspaceId, row.session);
  };
  const empty = view === "changes" ? S.attachNoChanges : view === "sessions" ? S.attachSessionNone : view === "notion" ? N.attachNone : view === "notes" ? S.attachNoteNone : S.attachNone;

  return (
    <Popup anchor={anchor} placement="above" label={S.searchAttachments} className="popup-attach" onClose={onClose}>
      <input
        className="popup-input"
        autoFocus
        aria-label={S.searchAttachments}
        placeholder={S.searchAttachments}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(rows[index]);
          } else if (e.key === "Backspace" && !query && view !== "root") {
            setView("root");
            setIndex(0);
          }
        }}
      />
      <div className="popup-list" role="listbox">
        {rows.map((row, i) => (
          <button key={row.key} type="button" role="option" aria-selected={i === index} className="popup-row" data-active={i === index || undefined} onMouseEnter={() => setIndex(i)} onClick={() => choose(row)}>
            <RowContent row={row} />
          </button>
        ))}
        {rows.length === 0 && <div className="popup-empty">{files || view === "sessions" || view === "changes" || view === "notion" || view === "notes" ? empty : S.loading}</div>}
      </div>
    </Popup>
  );
}

type Row =
  | { key: string; kind: "category"; title: string; icon: ReactNode; go: View }
  // fixB: 파일 선택창을 열어 이미지를 붙인다
  | { key: string; kind: "image"; title: string; icon: ReactNode }
  | { key: string; kind: "file"; title: string; detail: string; name: string; choose: { workspaceId: string; path: string } }
  | { key: string; kind: "session"; title: string; session: Agent }
  // NOTES: 메모장의 메모. 본문 전체가 프롬프트에 글로 들어간다.
  | { key: string; kind: "note"; title: string; detail: string; note: Note }
  // NOTION: 고정한 페이지나 열린 Notion 탭. tabKey 가 있으면 그 탭에서 바로 읽는다.
  | { key: string; kind: "notion"; title: string; url: string; detail: string; tabKey?: string };

function RowContent({ row }: { row: Row }) {
  if (row.kind === "category" || row.kind === "image") {
    return (
      <>
        {row.icon}
        <span className="popup-row-title">{row.title}</span>
      </>
    );
  }
  if (row.kind === "notion") {
    return (
      <>
        <Codicon name="file" />
        <span className="popup-row-title">{row.title}</span>
        <span className="popup-row-detail">{row.detail}</span>
      </>
    );
  }
  if (row.kind === "note") {
    return (
      <>
        <NoteIcon />
        <span className="popup-row-title">{row.title}</span>
        <span className="popup-row-detail">{row.detail}</span>
      </>
    );
  }
  if (row.kind === "session") {
    return (
      <>
        <CommentDiscussion />
        <span className="popup-row-title">{row.title}</span>
      </>
    );
  }
  return (
    <>
      <FileTypeIcon name={row.title} />
      <span className="popup-row-title">{row.title}</span>
      <span className="popup-row-detail">{row.detail}</span>
    </>
  );
}

// 고정한 Notion 페이지와 열려 있는 Notion 탭을 한 목록으로(같은 페이지는 하나, 열린 탭이 있으면 그 탭에서 읽는다). 열린 탭을 앞에 둔다.
function notionRows(tabs: Tab[], query: string): Row[] {
  const rows = new Map<string, Extract<Row, { kind: "notion" }>>();
  for (const tab of tabs) {
    if (tab.kind !== "browser" || !isNotionUrl(tab.url)) continue;
    rows.set(notionPageKey(tab.url), { key: `n:${tab.key}`, kind: "notion", title: tab.title.trim() || tab.url, url: tab.url, detail: N.attachOpenTab, tabKey: tab.key });
  }
  for (const pin of notionPins()) {
    const key = notionPageKey(pin.url);
    const open = rows.get(key);
    if (open) rows.set(key, { ...open, title: pin.title });
    else rows.set(key, { key: `n:${pin.id}`, kind: "notion", title: pin.title, url: pin.url, detail: N.attachPinned });
  }
  const q = query.toLowerCase();
  return [...rows.values()].filter((r) => !q || r.title.toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
}

// 메모장의 메모를 최근 수정 순으로(제목과 미리보기에서 찾는다). 본문 전체 검색은 메모장 화면의 검색 칸이 한다.
function noteRows(notes: Note[], query: string): Row[] {
  const q = query.toLowerCase();
  return notes
    .filter((n) => !q || `${n.title} ${n.preview}`.toLowerCase().includes(q))
    .slice(0, 50)
    .map((note) => ({ key: `note:${note.id}`, kind: "note", title: note.title || S.notesUntitled, detail: note.preview, note }));
}
