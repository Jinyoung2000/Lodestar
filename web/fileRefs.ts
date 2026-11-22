import { EXTENSIONS, parseCodeSpanRef, parseFileRefs, type FileRef } from "./fileRefParse";
export type { FileRef } from "./fileRefParse";
import { fileIndex, normalizeRelative, resolveFileRef } from "./fileRefResolve";
import { toTarget } from "./lsp";
import { rpc } from "./rpc";
import { ensureFiles, getState, openFile, setState, type FileTarget } from "./store";

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

export function folderHref(href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("file:")) return null;
  const path = decodeURIComponent(href.replace(/^file:\/\//, "").split("#")[0]).replace(/\/+$/, "");
  if (!/^(?:~\/|\/)[^/]/.test(path)) return null;
  const last = path.split("/").at(-1) ?? "";
  return last.includes(".") ? null : path;
}

export function openLinkOutside(event: { defaultPrevented: boolean; button: number; target: EventTarget; preventDefault: () => void }) {
  if (event.defaultPrevented || event.button !== 0) return;
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.target === "_blank") return;
  event.preventDefault();
  window.open(anchor.href, "_blank", "noopener");
}

export function linkifyElement(root: HTMLElement) {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const ref = parseHref(anchor.getAttribute("href") ?? "");
    const folder = ref ? null : folderHref(anchor.getAttribute("href") ?? "");
    if (ref) {
      anchor.dataset.file = JSON.stringify(ref);
      anchor.removeAttribute("href");
    } else if (folder) {
      anchor.dataset.folder = folder;
      anchor.removeAttribute("href");
      anchor.setAttribute("role", "link");
      anchor.tabIndex = 0;
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
    if (!node.parentElement?.closest("a, code[data-file], svg")) textNodes.push(node);
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
  const result = resolveFileRef(fileIndex(files), ref.raw, [], new Map());
  if (result.kind === "ambiguous") {
    setState({ overlay: { kind: "quickOpen" }, quickOpenQuery: normalizeRelative(ref.raw) });
    return;
  }
  const path = result.kind === "found" || result.kind === "missing" ? result.path : normalizeRelative(ref.raw);
  openFile({ workspaceId, path, ...base }, { side });
}

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

function expandHome(ref: FileRef): FileRef {
  if (!ref.raw.startsWith("~/")) return ref;
  for (const workspace of getState().workspaces) {
    const home = /^(?:\/Users|\/home)\/[^/]+/.exec(workspace.dir)?.[0];
    if (home) return { ...ref, raw: `${home}${ref.raw.slice(1)}` };
  }
  return ref;
}
