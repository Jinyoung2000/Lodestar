
export const TITLE_MAX = 80;

export function shortTitle(text: string, max = TITLE_MAX): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarkdown(raw);
    if (line) return clampTitle(line, max);
  }
  return "";
}

export function clampTitle(title: string, max: number): string {
  const text = title.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = space >= (max - 1) * 0.6 ? room.slice(0, space) : room;
  return `${cut.trimEnd()}…`;
}

function stripMarkdown(raw: string): string {
  const line = raw.trim();
  if (!line || /^(```|~~~)/.test(line) || /^([-*_])(\s*\1){2,}$/.test(line)) return "";
  return line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
