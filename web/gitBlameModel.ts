import type { EditorState, Text } from "@codemirror/state";
import type { BlameCommit, FileBlame } from "../shared/protocol";
import { relativeTimeLong } from "./sessionList";
import { S } from "./strings";

export type BlameData = { doc: Text; blame: FileBlame };

const INLINE_SUMMARY_CHARS = 80;

export function commitAtCursor(data: BlameData | null, state: EditorState): BlameCommit | null {
  if (!data || !state.doc.eq(data.doc)) return null;
  const line = state.doc.lineAt(state.selection.main.head).number;
  const index = data.blame.lines[line - 1];
  return index === undefined ? null : (data.blame.commits[index] ?? null);
}

export const authorName = (commit: BlameCommit) => (commit.you ? S.blameYou : commit.author);

export function agoText(commit: BlameCommit, now: number): string {
  return commit.uncommitted ? S.timeNow : relativeTimeLong(new Date(commit.time * 1000).toISOString(), now);
}

export const whoWhen = (commit: BlameCommit, now: number) => `${authorName(commit)}, ${agoText(commit, now)}`;

export const summaryText = (commit: BlameCommit) => (commit.uncommitted ? S.blameUncommitted : commit.summary);

export function inlineText(commit: BlameCommit, now: number): string {
  const summary = summaryText(commit);
  const short = summary.length > INLINE_SUMMARY_CHARS ? `${summary.slice(0, INLINE_SUMMARY_CHARS - 1)}…` : summary;
  return `${whoWhen(commit, now)} • ${short}`;
}

export const shortHash = (commit: BlameCommit) => commit.hash.slice(0, 7);

export function absoluteDate(commit: BlameCommit): string {
  return commit.uncommitted ? "" : new Date(commit.time * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function statusTitle(commit: BlameCommit): string {
  return commit.uncommitted ? S.blameUncommitted : S.blameStatusTitle(shortHash(commit), commit.summary, absoluteDate(commit));
}
