import { BOARD_LIMITS, columnByRole } from "./board";
import type { Board, BoardCard, CardSource } from "./protocol";

// 대화의 한 부분(답 메시지, 사용자 말, 드래그로 고른 글, 할 일 하나)을 Board 카드로 만드는 순수 계산. 화면은 web/ToBoardPopover.tsx, 시험은 test/toboard.test.ts.

export const TITLE_MAX = 80;

// 제목: 마크다운 기호를 벗기고 첫 문장만, 최대 max 자(넘으면 단어 경계에서 자르고 말줄임표). 글이 비면 빈 문자열.
// 첫 줄이 짧은 제목줄(`## Plan`)이고 그 뒤에 글이 있으면 "Plan: 다음 글의 첫 문장" 으로 잇는다. 제목줄만으로는 무슨 카드인지 모른다.
export function cardTitleFrom(text: string, max = TITLE_MAX): string {
  const lines = plainLines(text);
  if (!lines.length) return "";
  const [first, next] = lines;
  if (HEADING.test(text.trimStart()) && first.length <= HEADING_MAX && next) return clip(`${first.replace(/[:：]$/, "")}: ${firstSentence(next)}`, max);
  return clip(firstSentence(first), max);
}

// 카드 팝오버의 원문 미리보기: 마크다운 기호를 벗기고 한 줄로 이은 글.
export function plainExcerpt(text: string): string {
  return plainLines(text).join(" ");
}

const HEADING = /^#{1,6}\s/;
const HEADING_MAX = 24;

// 코드 블록 안은 뒤로 미루고(글 전체가 코드 블록이면 그 안의 줄을 쓴다) 비지 않은 줄을 기호 없이 돌려준다.
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

// 마침표, 물음표, 느낌표(전각 포함) 뒤에 공백이 오는 첫 자리까지. "e.g." 처럼 너무 짧게 끊기는 자리는 지나간다. 끝의 마침표는 뗀다.
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

// 선택한 글이나 할 일을 가리키는 지문. 공백을 접고 앞 200자만. 같은 글을 다시 고르면 같은 값이 나온다.
export function sourcePart(text: string | null): string | null {
  if (text === null) return null;
  const part = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return part || null;
}

export const messageLink = (agentId: string, itemId: string) => `#lodestar-message=${encodeURIComponent(agentId)}/${encodeURIComponent(itemId)}`;

// 카드 설명 안의 돌아가기 링크(messageLink)를 읽는다. 다른 모양이면 null.
export function parseMessageLink(href: string): { agentId: string; itemId: string } | null {
  const match = /^#lodestar-message=([^/]+)\/(.+)$/.exec(href);
  if (!match) return null;
  try {
    return { agentId: decodeURIComponent(match[1]), itemId: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

// 설명: 원문을 인용 블록으로, 그 아래 세션 이름과 돌아가기 링크. 설명 길이 한도(BOARD_LIMITS.body)를 넘으면 원문 뒤를 `> …` 로 줄인다.
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

// 같은 세션의 같은 항목, 같은 부분으로 이미 만든 카드. 항목 전체와 그 안의 선택은 서로 다른 부분이다.
export function findSourceCard(board: Board | null, source: CardSource): BoardCard | null {
  return board?.cards.find((c) => c.source && c.source.agentId === source.agentId && c.source.itemId === source.itemId && samePart(c.source.part, source.part)) ?? null;
}

// 기억해 둔 열이 아직 있으면 그 열, 없으면 Backlog, 그것도 없으면 첫 열.
export function pickColumn(board: Pick<Board, "columns">, remembered: string | null): string {
  if (remembered && board.columns.some((c) => c.id === remembered)) return remembered;
  return (columnByRole(board, "backlog") ?? board.columns[0]).id;
}
