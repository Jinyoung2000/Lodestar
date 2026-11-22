import { BOARD_LIMITS, columnByRole } from "./board";
import type { Board, BoardCard, CardSource } from "./protocol";

export const TITLE_MAX = 80;

export function cardTitleFrom(text: string, max = TITLE_MAX): string {
  const lines = plainLines(text);
  if (!lines.length) return "";
  const [first, next] = lines;
  if (HEADING.test(text.trimStart()) && first.length <= HEADING_MAX && next) return clip(`${first.replace(/[:：]$/, "")}: ${firstSentence(next)}`, max);
  return clip(firstSentence(first), max);
}

export function plainExcerpt(text: string): string {
  return plainLines(text).join(" ");
}

const HEADING = /^#{1,6}\s/;
const HEADING_MAX = 24;

function plainLines(text: string): string[] {
  const outside: string[] = [];
  const inside: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    (fenced ? inside : outside).push(raw);
  }
  return [...outside, ...inside].map(plainLine).filter(Boolean);
}

function plainLine(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:>\s?)+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^\|\s*|\s*\|$/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?=[^\w_]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(line: string): string {
  const end = /[.!?。！？]+(?=\s|$)/g;
  for (let match = end.exec(line); match; match = end.exec(line)) {
    const sentence = line.slice(0, match.index + match[0].length);
    if (sentence.length >= 10 || match.index + match[0].length >= line.length) return sentence.replace(/[.。]+$/, "").trim();
  }
  return line;
}

function clip(title: string, max: number): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.\-]+$/, "")}…`;
}

export function sourcePart(text: string | null): string | null {
  if (text === null) return null;
  const part = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return part || null;
}

export const messageLink = (agentId: string, itemId: string) => `#lodestar-message=${encodeURIComponent(agentId)}/${encodeURIComponent(itemId)}`;

export function parseMessageLink(href: string): { agentId: string; itemId: string } | null {
  const match = /^#lodestar-message=([^/]+)\/(.+)$/.exec(href);
  if (!match) return null;
  try {
    return { agentId: decodeURIComponent(match[1]), itemId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

export function cardBodyFrom({ text, sessionTitle, agentId, itemId }: { text: string; sessionTitle: string; agentId: string; itemId: string }): string {
  const name = sessionTitle.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim() || "Untitled";
  const footer = `From session: ${name}\n\n[Go to message](${messageLink(agentId, itemId)})`;
  const budget = BOARD_LIMITS.body - footer.length - 2 - 4;
  const lines: string[] = [];
  let used = 0;
  let cut = false;
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trimEnd() ? `> ${raw.trimEnd()}` : ">";
    if (used + line.length + 1 > budget) {
      cut = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (cut) lines.push("> …");
  return `${lines.join("\n")}\n\n${footer}`;
}

const samePart = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);

export function findSourceCard(board: Board | null, source: CardSource): BoardCard | null {
  return board?.cards.find((c) => c.source && c.source.agentId === source.agentId && c.source.itemId === source.itemId && samePart(c.source.part, source.part)) ?? null;
}

export function pickColumn(board: Pick<Board, "columns">, remembered: string | null): string {
  if (remembered && board.columns.some((c) => c.id === remembered)) return remembered;
  return (columnByRole(board, "backlog") ?? board.columns[0]).id;
}
