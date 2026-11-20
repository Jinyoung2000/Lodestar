// 메모장(Notes). 데몬이 `$AGENT_NAV_HOME/notes/<id>.md` 로 저장하고, 화면은 목록 요약(Note)만 받는다. 본문(NoteDoc.text)은 notes.get 으로 읽는다.
// DOM 과 Node 에 의존하지 않아서 서버, 웹, 단위 시험이 같이 쓴다.

// 목록 줄 하나. title 은 본문 첫 줄, preview 는 그 다음 줄들, rev 는 본문 해시라서 같은 글이면 같은 값이다(다른 창이 바꿨는지 가르는 데 쓴다).
export type Note = { id: string; title: string; preview: string; updatedAt: string; rev: string };
export type NoteDoc = Note & { text: string };

export const NOTE_ID = /^[a-z0-9]{6,12}-[a-f0-9]{6}$/;
export const NOTE_MAX_CHARS = 200_000;
export const NOTE_TITLE_MAX = 80;
export const NOTE_PREVIEW_MAX = 120;

export const isNoteId = (id: unknown): id is string => typeof id === "string" && NOTE_ID.test(id);

// 제목: 비어 있지 않은 첫 줄에서 마크다운 머리표(#, >, -, *, 번호)를 걷어 낸 글. 글이 없으면 빈 문자열이라 화면이 자리표시 문구를 보인다.
export function noteTitleOf(text: string): string {
  const line = firstLines(text, 1)[0] ?? "";
  return clip(stripMarkdownLead(line), NOTE_TITLE_MAX);
}

// 미리보기: 제목 줄 다음의 비어 있지 않은 줄들을 한 줄로 잇는다.
export function notePreviewOf(text: string): string {
  const lines = firstLines(text, 3).slice(1);
  return clip(lines.map(stripMarkdownLead).join(" "), NOTE_PREVIEW_MAX);
}

// 검색어의 낱말이 모두 본문에 들어 있는 메모(대소문자 무시). 빈 검색어는 모두 맞는다.
export function noteMatches(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// 최근에 고친 것이 위. 같은 시각이면 id 순으로 고정해 목록이 출렁이지 않게 한다.
export function byRecent(a: Pick<Note, "id" | "updatedAt">, b: Pick<Note, "id" | "updatedAt">): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function firstLines(text: string, count: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    out.push(line);
    if (out.length === count) break;
  }
  return out;
}

function stripMarkdownLead(line: string): string {
  return line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
