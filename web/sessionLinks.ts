import { findSessionRefs, resolveSessionRef } from "../shared/sessionRef";
import { flash, getState, openAgent } from "./store";
import { S } from "./strings";

// 대화 속 세션 참조(lodestar://session/..., 예전 agent-nav://session/...)를 눌러 그 세션을 연다.
// 링크는 외부 주소가 아니어서 DOMPurify 가 href 를 지우므로(Timeline 의 Markdown 이 허용 목록에 넣어 준다), 앵커에는 href 대신 data-session 만 남기고 클릭은 문서 한 곳에서 받는다.
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

// 참조를 풀어 연다. ⌥클릭은 옆 칸에 연다. 풀리지 않으면 알린다.
export function openSessionRef(ref: string, side = false) {
  const result = resolveSessionRef(ref, getState().agents);
  if (result.kind === "found") openAgent(result.agent.id, side ? "new" : "active");
  else flash(result.kind === "ambiguous" ? S.ambiguousSessionRef : S.unknownSessionRef);
}

// 렌더된 글 안의 참조를 누를 수 있게 한다. 이미 링크인 참조는 href 를 data-session 으로 바꾸고, 글 속 참조는 감싼다.
// 코드 블록(pre) 안은 건드리지 않는다. 인라인 코드 안의 참조는 감싼다(모델이 백틱으로 자주 쓴다).
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
    if (!node.parentElement?.closest("a, pre")) nodes.push(node);
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

// DOMPurify 기본 허용 주소에 세션 참조만 더한 것. 이 주소가 아니면 lodestar:// 링크의 href 가 지워진다.
export const MARKDOWN_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|(?:lodestar|agent-nav):\/\/session\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
