import { findSessionRefs, resolveSessionRef } from "../shared/sessionRef";
import { flash, getState, openAgent, openEditorChatSession } from "./store";
import { S } from "./strings";

export function initSessionLinks() {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as Element | null)?.closest?.<HTMLElement>("[data-session]");
      if (!anchor?.dataset.session) return;
      event.preventDefault();
      openSessionRef(anchor.dataset.session, event.altKey);
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const anchor = (event.target as Element | null)?.closest?.<HTMLElement>("[data-session]");
    if (!anchor?.dataset.session) return;
    event.preventDefault();
    openSessionRef(anchor.dataset.session, event.altKey);
  });
}

export function openSessionRef(ref: string, side = false) {
  const result = resolveSessionRef(ref, getState().agents);
  if (result.kind !== "found") {
    flash(result.kind === "ambiguous" ? S.ambiguousSessionRef : S.unknownSessionRef);
    return;
  }
  if (getState().layoutMode === "editor") openEditorChatSession(result.agent.id);
  else openAgent(result.agent.id, side ? "new" : "active");
}

export function linkifySessionRefs(root: HTMLElement) {
  if (!root.textContent?.includes("session/") && !root.querySelector("a[href*='session/']")) return;
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const id = findSessionRefs(anchor.getAttribute("href") ?? "")[0];
    if (!id) continue;
    mark(anchor, id);
    anchor.removeAttribute("href");
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a, pre, svg")) nodes.push(node);
  }
  for (const node of nodes) wrapRefs(node);
}

function wrapRefs(node: Text) {
  const text = node.data;
  const pattern = /(?:lodestar|agent-nav):\/\/session\/[0-9a-f][0-9a-f-]{5,35}/gi;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const id = findSessionRefs(match[0])[0];
    if (!id) continue;
    fragment.append(text.slice(cursor, match.index));
    const anchor = document.createElement("a");
    mark(anchor, id);
    anchor.textContent = match[0];
    fragment.append(anchor);
    cursor = match.index + match[0].length;
  }
  if (!cursor) return;
  fragment.append(text.slice(cursor));
  node.replaceWith(fragment);
}

function mark(anchor: HTMLElement, id: string) {
  anchor.className = "session-link";
  anchor.dataset.session = id;
  anchor.setAttribute("role", "link");
  anchor.tabIndex = 0;
}

export const MARKDOWN_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|(?:lodestar|agent-nav):\/\/session\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
