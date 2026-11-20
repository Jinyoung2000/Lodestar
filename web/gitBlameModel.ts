import type { EditorState, Text } from "@codemirror/state";
import type { BlameCommit, FileBlame } from "../shared/protocol";
import { relativeTimeLong } from "./sessionList";
import { S } from "./strings";

// 커서 줄 blame(web/gitBlame.ts)의 문구를 만드는 순수 함수. GitLens 기본 형식을 따른다:
// 줄 끝 주석 `mina, 3 weeks ago • Add loud option`, 커밋 안 된 줄은 `You, now • Uncommitted changes`.

// 서버가 준 blame 과 그 blame 이 계산된 문서. 문서가 그 사이 바뀌면 줄 번호가 어긋나므로 같은 문서일 때만 쓴다.
export type BlameData = { doc: Text; blame: FileBlame };

const INLINE_SUMMARY_CHARS = 80;

// 커서(선택이 여러 줄이어도 head) 줄을 쓴 커밋. 문서가 blame 계산 때와 다르거나 그 줄 정보가 없으면 null.
export function commitAtCursor(data: BlameData | null, state: EditorState): BlameCommit | null {
  if (!data || !state.doc.eq(data.doc)) return null;
  const line = state.doc.lineAt(state.selection.main.head).number;
  const index = data.blame.lines[line - 1];
  return index === undefined ? null : (data.blame.commits[index] ?? null);
}

export const authorName = (commit: BlameCommit) => (commit.you ? S.blameYou : commit.author);

// 상대 시간. 커밋 안 된 줄은 항상 now.
export function agoText(commit: BlameCommit, now: number): string {
  return commit.uncommitted ? S.timeNow : relativeTimeLong(new Date(commit.time * 1000).toISOString(), now);
}

// `작성자, 상대시간`: 상태 표시줄 항목이자 줄 끝 주석 앞부분
export const whoWhen = (commit: BlameCommit, now: number) => `${authorName(commit)}, ${agoText(commit, now)}`;

export const summaryText = (commit: BlameCommit) => (commit.uncommitted ? S.blameUncommitted : commit.summary);

// 줄 끝 주석 전체. 제목이 길면 잘라서 줄이 한없이 길어지지 않게 한다.
export function inlineText(commit: BlameCommit, now: number): string {
  const summary = summaryText(commit);
  const short = summary.length > INLINE_SUMMARY_CHARS ? `${summary.slice(0, INLINE_SUMMARY_CHARS - 1)}…` : summary;
  return `${whoWhen(commit, now)} • ${short}`;
}

export const shortHash = (commit: BlameCommit) => commit.hash.slice(0, 7);

// hover 카드의 절대 날짜(`Oct 12, 2026, 3:04 PM`). 커밋 안 된 줄은 날짜가 없다.
export function absoluteDate(commit: BlameCommit): string {
  return commit.uncommitted ? "" : new Date(commit.time * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

// 상태 표시줄 항목 툴팁: 짧은 해시와 제목, 날짜
export function statusTitle(commit: BlameCommit): string {
  return commit.uncommitted ? S.blameUncommitted : S.blameStatusTitle(shortHash(commit), commit.summary, absoluteDate(commit));
}
