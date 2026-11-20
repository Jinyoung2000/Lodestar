import { EXTENSIONS, parseCodeSpanRef, parseFileRefs, type FileRef } from "./fileRefParse";
export type { FileRef } from "./fileRefParse";
import { fileIndex, normalizeRelative, resolveFileRef } from "./fileRefResolve";
import { toTarget } from "./lsp";
import { rpc } from "./rpc";
import { ensureFiles, getState, openFile, setState, type FileTarget } from "./store";

// 마크다운 링크 [Report.tsx:12](src/Report.tsx#L12) 의 href 를 파일 참조로 읽는다.
export function parseHref(href: string): FileRef | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) return null;
  const clean = href.replace(/^file:\/\//, "");
  const [pathPart, hash = ""] = clean.split("#");
  const lineMatch = /^L(\d+)(?:C(\d+))?/.exec(hash) ?? /:(\d+)(?::(\d+))?$/.exec(pathPart);
  const path = decodeURIComponent(pathPart.replace(/:(\d+)(?::(\d+))?$/, ""));
  if (!new RegExp(`\\.(?:${EXTENSIONS})$`).test(path)) return null;
  return {
    raw: path,
    line: lineMatch ? Number(lineMatch[1]) : undefined,
    column: lineMatch?.[2] ? Number(lineMatch[2]) : undefined,
  };
}

// 문자열로 그린 마크다운(곁다리 대화 답, Notion 페이지 본문)의 링크는 target 이 없어서 누르면 앱 창이 그 주소로 옮겨 간다. 새 창 요청으로 바꿔 바깥에서 열게 한다.
// Notion 링크는 문서의 캡처 단계 처리(web/notionLinks.ts)가 먼저 가져가고 기본 동작을 막아 두므로 여기서는 건너뛴다.
export function openLinkOutside(event: { defaultPrevented: boolean; button: number; target: EventTarget; preventDefault: () => void }) {
  if (event.defaultPrevented || event.button !== 0) return;
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.target === "_blank") return;
  event.preventDefault();
  window.open(anchor.href, "_blank", "noopener");
}

// 텍스트 노드 안의 파일 경로를 a[data-file] 로 감싼다. 이미 링크인 곳은 href 를 읽어 바꾼다.
export function linkifyElement(root: HTMLElement) {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const ref = parseHref(anchor.getAttribute("href") ?? "");
    if (ref) {
      anchor.dataset.file = JSON.stringify(ref);
      anchor.removeAttribute("href");
    } else {
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
    }
  }
  for (const code of root.querySelectorAll<HTMLElement>("code")) {
    if (code.closest("pre, a")) continue;
    const ref = parseCodeSpanRef(code.textContent ?? "");
    if (!ref) continue;
    code.dataset.file = JSON.stringify(ref);
    code.setAttribute("role", "link");
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a, code[data-file]")) textNodes.push(node);
  }
  for (const node of textNodes) {
    const text = node.data;
    const refs = parseFileRefs(text);
    if (!refs.length) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const { index, length, ref } of refs) {
      fragment.append(text.slice(cursor, index));
      const anchor = document.createElement("a");
      anchor.className = "file-link";
      anchor.dataset.file = JSON.stringify(ref);
      anchor.textContent = text.slice(index, index + length);
      fragment.append(anchor);
      cursor = index + length;
    }
    fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
  }
}

// 상대 경로가 워크스페이스 파일 목록과 정확히 맞지 않으면 접미사로 찾는다 (예: Report.tsx:275). 링크를 그릴 때 이미 풀어 둔 경로(web/fileRefMark.ts)는 정확히 맞는다.
// side 가 true 면 옆 그룹에 연다(⌥클릭, ⌥⌘클릭).
export async function openFileRef(workspaceId: string, ref: FileRef, extra: Partial<FileTarget> = {}, side = false) {
  ref = expandHome(ref);
  const base = { line: ref.line, column: ref.column, ...extra };
  if (ref.raw.startsWith("/")) {
    const target = toTarget(ref.raw, workspaceId);
    const outside = target.path.startsWith("../") || target.path.startsWith("/");
    openFile({ ...((outside && (await sameFileInWorkspace(workspaceId, ref.raw))) || target), ...base }, { side });
    return;
  }
  const files = await ensureFiles(workspaceId);
  // 링크를 그릴 때와 같은 풀이(web/fileRefResolve.ts). 디스크 확인은 하지 않으니 목록에 없는 경로는 그대로 열고, 에디터가 없는 파일 안내를 보인다.
  const result = resolveFileRef(fileIndex(files), ref.raw, [], new Map());
  if (result.kind === "ambiguous") {
    setState({ overlay: { kind: "quickOpen" }, quickOpenQuery: normalizeRelative(ref.raw) });
    return;
  }
  const path = result.kind === "found" || result.kind === "missing" ? result.path : normalizeRelative(ref.raw);
  openFile({ workspaceId, path, ...base }, { side });
}

// 워크스페이스 밖 절대 경로가 디스크에 없으면(지운 워크트리 등) 같은 꼬리 경로의 워크스페이스 파일을 찾는다. 가장 긴 꼬리부터, 폴더 하나 이상을 포함한 것만.
// 예: 없어진 /Users/me/Repository/app-x/src/a/b.ts 는 app 워크스페이스의 src/a/b.ts 로 연다.
async function sameFileInWorkspace(workspaceId: string, absolute: string): Promise<FileTarget | null> {
  const exists = await rpc
    .call("files.stat", { workspaceId, path: absolute })
    .then(({ mtimeMs }) => mtimeMs !== null)
    .catch(() => false);
  if (exists) return null;
  const files = await ensureFiles(workspaceId).catch(() => null);
  if (!files) return null;
  const { set } = fileIndex(files);
  const parts = absolute.split("/").filter(Boolean);
  for (let i = 1; i < parts.length - 1; i += 1) {
    const tail = parts.slice(i).join("/");
    if (set.has(tail)) return { workspaceId, path: tail };
  }
  return null;
}

// 폴더 없는 대화(Chats)의 파일 링크가 열릴 워크스페이스. 절대 경로는 그 경로를 품은 워크스페이스,
// 상대 경로는 대화의 도구 호출이 가장 많이 만진 워크스페이스 폴더로 본다. 못 찾으면 null.
export function chatWorkspaceFor(agentId: string, ref: FileRef): string | null {
  const { workspaces, timelines } = getState();
  const raw = expandHome(ref).raw;
  const byDir = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
  if (raw.startsWith("/")) return byDir.find((w) => raw.startsWith(`${w.dir}/`))?.id ?? null;
  const inputs = (timelines[agentId] ?? []).flatMap((item) => (item.kind === "tool" ? [JSON.stringify(item.input)] : []));
  let best: { id: string; count: number } | null = null;
  for (const w of byDir) {
    const count = inputs.filter((text) => text.includes(`${w.dir}/`) || text.includes(`${w.dir}"`)).length;
    if (count && (!best || count > best.count)) best = { id: w.id, count };
  }
  return best?.id ?? null;
}

// ~/ 는 작업 폴더 경로(/Users/name/...)에서 홈 폴더를 읽어 푼다. 클라이언트는 홈 폴더를 따로 모른다.
function expandHome(ref: FileRef): FileRef {
  if (!ref.raw.startsWith("~/")) return ref;
  for (const workspace of getState().workspaces) {
    const home = /^(?:\/Users|\/home)\/[^/]+/.exec(workspace.dir)?.[0];
    if (home) return { ...ref, raw: `${home}${ref.raw.slice(1)}` };
  }
  return ref;
}
