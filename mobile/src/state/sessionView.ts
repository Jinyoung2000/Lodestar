import type { QuestionState } from "../logic/questions";

export type RequestDraft = { id: string; states?: QuestionState[]; page: number; expanded: boolean; feedback: string | null };
type SessionViewState = { offset: number | null; collapsedImages: Set<string>; request?: RequestDraft };
const sessions = new Map<string, SessionViewState>();

export function sessionViewState(id: string): SessionViewState {
  const saved = sessions.get(id);
  if (saved) return saved;
  const state: SessionViewState = { offset: null, collapsedImages: new Set() };
  sessions.set(id, state);
  return state;
}

export function requestDraft(session: SessionViewState, id: string) {
  if (session.request?.id !== id) session.request = { id, page: 0, expanded: true, feedback: null };
  return session.request;
}

export function clearSessionViews() {
  sessions.clear();
}
