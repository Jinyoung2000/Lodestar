
export type Note = { id: string; title: string; preview: string; updatedAt: string; rev: string };
export type NoteDoc = Note & { text: string };

export const NOTE_ID = /^[a-z0-9]{6,12}-[a-f0-9]{6}$/;
export const NOTE_MAX_CHARS = 200_000;
export const NOTE_TITLE_MAX = 80;
export const NOTE_PREVIEW_MAX = 120;

export const isNoteId = (id: unknown): id is string => typeof id === "string" && NOTE_ID.test(id);

export function noteTitleOf(text: string): string {
  const line = firstLines(text, 1)[0] ?? "";
  return clip(stripMarkdownLead(line), NOTE_TITLE_MAX);
}

export function notePreviewOf(text: string): string {
  const lines = firstLines(text, 3).slice(1);
  return clip(lines.map(stripMarkdownLead).join(" "), NOTE_PREVIEW_MAX);
}

export function noteMatches(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

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
